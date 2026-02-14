/**
 * Audio hydration script — post-processing tool for Phase 1.
 *
 * Reconstructs time-aligned audio from speech-only OGG files using
 * burst timestamps from the database. Uses anchor-based alignment
 * (burst_start - first_packet_at per track) to prevent cumulative
 * drift from packet loss.
 *
 * Usage:
 *   npm run hydrate-audio <session-id>         — per-user hydrated WAVs
 *   npm run hydrate-audio <session-id> --mix   — also produce combined session mix
 *
 * Requires: ffmpeg installed on the host.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { getConfig } from '../src/config.js';
import { initDb, closeDb } from '../src/db/index.js';
import {
  getSession,
  getSessionTracks,
  getTrackBursts,
  type AudioTrackRow,
  type SpeechBurstRow,
} from '../src/db/queries.js';

const execFileAsync = promisify(execFile);

// Audio constants matching our OGG muxer (ogg-muxer.ts)
const SAMPLE_RATE = 48000;
const CHANNELS = 2; // Stereo (matches OpusHead channel count)
const BYTES_PER_SAMPLE = 2; // 16-bit signed LE
const FRAME_SAMPLES = 960; // 20ms at 48kHz
const BYTES_PER_FRAME = FRAME_SAMPLES * CHANNELS * BYTES_PER_SAMPLE; // 3840
const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE; // 192000

// 64KB silence chunk for streaming writes (avoids large buffer allocations)
const SILENCE_CHUNK_SIZE = 65536;
const SILENCE_CHUNK = Buffer.alloc(SILENCE_CHUNK_SIZE, 0);

// Max silence gap: 5 minutes (300s). Gaps beyond this are likely timestamp
// anomalies or very long AFK periods — cap to avoid giant output files.
const MAX_SILENCE_BYTES = 300 * BYTES_PER_SECOND;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sessionId = args.find((a) => !a.startsWith('-'));
  const mixFlag = args.includes('--mix');
  const noClampFlag = args.includes('--no-clamp');

  if (!sessionId) {
    console.error('Usage: npm run hydrate-audio <session-id> [--mix] [--no-clamp]');
    process.exit(1);
  }

  if (noClampFlag) {
    console.log('  --no-clamp: silence gaps will NOT be capped (research mode — files may be very large)');
  }

  // Verify ffmpeg is available
  try {
    await execFileAsync('ffmpeg', ['-version']);
  } catch {
    console.error('ffmpeg is required but was not found. Install it and try again.');
    process.exit(1);
  }

  initDb();

  try {
    const session = getSession(sessionId);
    if (!session) {
      console.error(`Session not found: ${sessionId}`);
      process.exit(1);
    }

    const tracks = getSessionTracks(sessionId);
    if (tracks.length === 0) {
      console.error('No audio tracks found for this session.');
      process.exit(1);
    }

    const config = getConfig();
    const outputDir = path.join(path.resolve(config.dataDir), sessionId, 'hydrated');
    fs.mkdirSync(outputDir, { recursive: true });

    console.log(`Hydrating session ${sessionId}`);
    console.log(`  Tracks: ${tracks.length}`);
    console.log(`  Output: ${outputDir}`);

    const hydratedFiles: string[] = [];

    for (const track of tracks) {
      const result = await hydrateTrack(track, outputDir, noClampFlag);
      if (result) {
        hydratedFiles.push(result);
      }
    }

    if (hydratedFiles.length === 0) {
      console.error('No tracks were hydrated (no bursts or missing files).');
      process.exit(1);
    }

    console.log(`\nHydrated ${hydratedFiles.length} track(s).`);

    if (mixFlag && hydratedFiles.length > 0) {
      const mixOutput = path.join(outputDir, 'session_mix.wav');
      await mixTracks(hydratedFiles, mixOutput);
    }

    console.log('\nDone.');
  } finally {
    closeDb();
  }
}

async function hydrateTrack(track: AudioTrackRow, outputDir: string, noClamp = false): Promise<string | null> {
  const bursts = getTrackBursts(track.id);
  if (bursts.length === 0) {
    console.log(`  Track ${track.id} (user ${track.user_id}): no bursts, skipping`);
    return null;
  }

  if (!track.first_packet_at) {
    console.log(`  Track ${track.id} (user ${track.user_id}): no first_packet_at, skipping`);
    return null;
  }

  const inputFile = path.resolve(track.file_path);
  if (!fs.existsSync(inputFile)) {
    console.error(`  Track ${track.id}: file not found: ${inputFile}`);
    return null;
  }

  const trackBaseName = path.basename(track.file_path, '.ogg');
  const outputFile = path.join(outputDir, `${trackBaseName}.wav`);
  const tempDecoded = outputFile + '.pcm';
  const tempHydrated = outputFile + '.hydrated.pcm';

  try {
    // Step 1: Decode OGG to raw PCM
    console.log(`  Track ${track.id} (user ${track.user_id}): decoding...`);
    await runFfmpeg([
      '-i', inputFile,
      '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS),
      '-y', tempDecoded,
    ]);

    const decodedPcm = fs.readFileSync(tempDecoded);
    const totalDecodedFrames = Math.floor(decodedPcm.length / BYTES_PER_FRAME);
    console.log(`    Decoded: ${totalDecodedFrames} frames (${(decodedPcm.length / BYTES_PER_SECOND).toFixed(1)}s of speech)`);

    // Step 2: Build hydrated output with anchor-based alignment
    //
    // Each burst is positioned at its absolute wall-clock offset from first_packet_at.
    // silence_to_insert = (burst_start - first_packet_at) - current_output_duration
    // This self-corrects drift from packet loss within previous bursts.
    const firstPacketAt = new Date(track.first_packet_at).getTime();
    const fd = fs.openSync(tempHydrated, 'w');
    let currentOutputBytes = 0;
    let burstsProcessed = 0;

    // Defensive sort by burst_start (DB returns ORDER BY burst_start, but guard against changes)
    const sortedBursts = [...bursts].sort((a, b) =>
      new Date(a.burst_start).getTime() - new Date(b.burst_start).getTime()
    );

    for (const burst of sortedBursts) {
      const burstStartMs = new Date(burst.burst_start).getTime();
      const targetPositionS = (burstStartMs - firstPacketAt) / 1000;
      const targetPositionBytes = Math.floor(targetPositionS * BYTES_PER_SECOND);

      // Align to frame boundary for clean audio
      const alignedTarget = targetPositionBytes - (targetPositionBytes % BYTES_PER_FRAME);

      // Insert silence gap (anchor-based: silence = target - current)
      let silenceBytes = alignedTarget - currentOutputBytes;
      if (!noClamp && silenceBytes > MAX_SILENCE_BYTES) {
        const gapS = silenceBytes / BYTES_PER_SECOND;
        console.warn(
          `    WARNING: burst ${burst.id} silence gap (${gapS.toFixed(1)}s) exceeds ${MAX_SILENCE_BYTES / BYTES_PER_SECOND}s cap — clamping`
        );
        silenceBytes = MAX_SILENCE_BYTES;
      }
      if (silenceBytes > 0) {
        writeSilence(fd, silenceBytes);
        currentOutputBytes += silenceBytes;
      }

      // Extract burst audio from decoded PCM using frame offsets
      const startByte = burst.start_frame_offset * BYTES_PER_FRAME;
      // For unclosed bursts (crash recovery), use all remaining frames
      const endFrameOffset = burst.end_frame_offset ?? totalDecodedFrames;
      const endByte = endFrameOffset * BYTES_PER_FRAME;

      // Warn if burst offsets exceed decoded data (indicates tracking drift)
      if (endFrameOffset > totalDecodedFrames) {
        console.warn(
          `    WARNING: burst ${burst.id} end_frame_offset (${endFrameOffset}) exceeds decoded frames (${totalDecodedFrames}) -- possible tracking drift`
        );
      }
      if (burst.start_frame_offset > totalDecodedFrames) {
        console.warn(
          `    WARNING: burst ${burst.id} start_frame_offset (${burst.start_frame_offset}) exceeds decoded frames (${totalDecodedFrames}) -- skipping`
        );
        continue;
      }

      // Clamp to actual file bounds
      const clampedStart = Math.min(startByte, decodedPcm.length);
      const clampedEnd = Math.min(endByte, decodedPcm.length);

      if (clampedStart < clampedEnd) {
        const burstAudio = decodedPcm.subarray(clampedStart, clampedEnd);
        fs.writeSync(fd, burstAudio);
        currentOutputBytes += burstAudio.length;
        burstsProcessed++;
      }
    }

    fs.closeSync(fd);

    const totalDurationS = currentOutputBytes / BYTES_PER_SECOND;
    console.log(`    Hydrated: ${burstsProcessed} burst(s), ${totalDurationS.toFixed(1)}s total duration`);

    // Step 3: Encode raw PCM to WAV
    await runFfmpeg([
      '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS),
      '-i', tempHydrated,
      '-y', outputFile,
    ]);

    console.log(`    Output: ${path.basename(outputFile)}`);
    return outputFile;
  } finally {
    // Clean up temp files
    try { fs.unlinkSync(tempDecoded); } catch { /* ignore */ }
    try { fs.unlinkSync(tempHydrated); } catch { /* ignore */ }
  }
}

/** Write silence (zero bytes) in chunks to avoid large buffer allocations. */
function writeSilence(fd: number, bytes: number): void {
  let remaining = bytes;
  while (remaining > 0) {
    const toWrite = Math.min(remaining, SILENCE_CHUNK_SIZE);
    fs.writeSync(fd, SILENCE_CHUNK, 0, toWrite);
    remaining -= toWrite;
  }
}

/**
 * Mix all hydrated tracks into a single combined file.
 * Uses ffmpeg amix (longest duration) + loudnorm (-14 LUFS) to prevent clipping.
 */
async function mixTracks(inputFiles: string[], outputFile: string): Promise<void> {
  console.log(`\nMixing ${inputFiles.length} track(s)...`);

  const inputArgs = inputFiles.flatMap((f) => ['-i', f]);
  const n = inputFiles.length;

  // amix combines all inputs; loudnorm normalizes to broadcast standard (-14 LUFS)
  const filter = n > 1
    ? `amix=inputs=${n}:duration=longest,loudnorm`
    : 'loudnorm'; // Single track: just normalize

  await runFfmpeg([
    ...inputArgs,
    '-filter_complex', filter,
    '-y', outputFile,
  ]);

  console.log(`  Mixed output: ${path.basename(outputFile)}`);
}

/** Run ffmpeg, using nice -n 19 on Unix for lowest scheduling priority. */
async function runFfmpeg(args: string[]): Promise<void> {
  const ffmpegArgs = ['-hide_banner', '-loglevel', 'warning', ...args];

  if (process.platform !== 'win32') {
    try {
      await execFileAsync('nice', ['-n', '19', 'ffmpeg', ...ffmpegArgs]);
      return;
    } catch (err: unknown) {
      // If nice itself failed (not found), fall back to direct ffmpeg.
      // If ffmpeg failed, re-throw (nice succeeded but ffmpeg errored).
      const msg = err instanceof Error ? err.message : '';
      if (!msg.includes('ENOENT') && !msg.includes('nice')) {
        throw err;
      }
    }
  }

  await execFileAsync('ffmpeg', ffmpegArgs);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
