#!/usr/bin/env tsx
/**
 * Post-session re-transcription script.
 *
 * Usage:
 *   npm run retranscribe <session-id> [options]
 *
 * Options:
 *   --engine whisper|google-cloud-stt|gemini   STT engine (default: google-cloud-stt)
 *   --diarized                                  Enable speaker diarization
 *   --min-speakers N                            Min speakers for diarization (default: from config)
 *   --max-speakers N                            Max speakers for diarization (default: from config)
 *   --clear                                     Clear existing transcript segments before re-transcription
 *
 * Decodes OGG audio files for a session, runs STT, and stores transcript segments.
 * For diarized mode, splits long audio into chunks and groups words by speaker.
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { initDb, getDb } from '../src/db/index.js';
import { getConfig } from '../src/config.js';
import {
  getSession,
  getSessionTracks,
  insertTranscriptSegment,
  updateTrackSttStatus,
} from '../src/db/queries.js';

const CHUNK_DURATION_SEC = 55; // Stay under Google's 1-minute synchronous limit

function usage(): never {
  console.log(`Usage: npm run retranscribe <session-id> [options]

Options:
  --engine <name>      STT engine: whisper|google-cloud-stt|gemini (default: google-cloud-stt)
  --diarized           Enable speaker diarization (splits audio into chunks)
  --min-speakers <N>   Minimum speakers for diarization (default: from config.json)
  --max-speakers <N>   Maximum speakers for diarization (default: from config.json)
  --clear              Clear existing transcript segments before re-transcription`);
  process.exit(1);
}

async function decodeOggToWav(oggPath: string, wavPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-y',
      '-i', oggPath,
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      wavPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', reject);
  });
}

/** Get audio duration in seconds using ffprobe. */
async function getAudioDuration(wavPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      wavPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('exit', (code) => {
      if (code === 0) {
        const duration = parseFloat(stdout.trim());
        if (Number.isFinite(duration)) {
          resolve(duration);
        } else {
          reject(new Error(`ffprobe returned non-numeric duration: ${stdout.trim()}`));
        }
      } else {
        reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', reject);
  });
}

/** Split a WAV file into fixed-duration chunks using ffmpeg. Returns chunk file paths. */
async function splitAudioChunks(wavPath: string, chunkDir: string, durationSec: number, chunkLenSec: number): Promise<string[]> {
  const chunkCount = Math.ceil(durationSec / chunkLenSec);
  const chunks: string[] = [];

  for (let i = 0; i < chunkCount; i++) {
    const startSec = i * chunkLenSec;
    const chunkPath = path.join(chunkDir, `chunk_${String(i).padStart(4, '0')}.wav`);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-y',
        '-ss', String(startSec),
        '-t', String(chunkLenSec),
        '-i', wavPath,
        '-ar', '16000',
        '-ac', '1',
        '-f', 'wav',
        chunkPath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      proc.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg chunk split exited with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', reject);
    });

    chunks.push(chunkPath);
  }

  return chunks;
}

async function transcribeWithGoogleCloud(
  wavPath: string,
  userId: string,
  sessionId: string,
  trackId: number,
  trackStartedAt: string,
  tmpDir: string
): Promise<number> {
  const { SpeechClient } = await import('@google-cloud/speech');
  const config = getConfig();
  const client = new SpeechClient({
    projectId: config.stt.googleCloud.projectId || undefined,
    keyFilename: config.stt.googleCloud.keyFile || undefined,
  });

  const baseTimeMs = new Date(trackStartedAt).getTime();
  const durationSec = await getAudioDuration(wavPath);
  console.log(`  Audio duration: ${Math.floor(durationSec / 60)}m ${Math.floor(durationSec % 60)}s`);

  // Chunk long files to stay under the 10MB / ~1 minute synchronous recognize() limit
  let chunkPaths: string[];
  let chunkOffsets: number[];

  if (durationSec <= CHUNK_DURATION_SEC) {
    chunkPaths = [wavPath];
    chunkOffsets = [0];
  } else {
    const chunkDir = path.join(tmpDir, 'chunks');
    if (!fs.existsSync(chunkDir)) {
      fs.mkdirSync(chunkDir, { recursive: true });
    }
    const chunkCount = Math.ceil(durationSec / CHUNK_DURATION_SEC);
    console.log(`  Splitting into ${chunkCount} chunks of ${CHUNK_DURATION_SEC}s each...`);
    chunkPaths = await splitAudioChunks(wavPath, chunkDir, durationSec, CHUNK_DURATION_SEC);
    chunkOffsets = chunkPaths.map((_, i) => i * CHUNK_DURATION_SEC);
  }

  let segmentCount = 0;

  for (let ci = 0; ci < chunkPaths.length; ci++) {
    const chunkPath = chunkPaths[ci];
    const chunkOffsetSec = chunkOffsets[ci];

    if (ci % 20 === 0 || ci === chunkPaths.length - 1) {
      console.log(`  Processing chunk ${ci + 1}/${chunkPaths.length}...`);
    }

    const audioContent = fs.readFileSync(chunkPath);

    const [response] = await client.recognize({
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
        languageCode: config.stt.googleCloud.languageCode,
        model: config.stt.googleCloud.model,
        enableAutomaticPunctuation: config.stt.googleCloud.enableAutomaticPunctuation,
      },
      audio: { content: audioContent },
    });

    if (response.results) {
      for (const result of response.results) {
        if (!result.alternatives || result.alternatives.length === 0) continue;
        const alt = result.alternatives[0];

        // resultEndTime is an offset from the start of the chunk audio.
        // Convert to absolute timestamp: base time + chunk offset + result offset.
        let segmentStart: string;
        if (result.resultEndTime) {
          const offsetMs = (Number(result.resultEndTime.seconds ?? 0) * 1000) +
            Math.floor(Number(result.resultEndTime.nanos ?? 0) / 1_000_000);
          segmentStart = new Date(baseTimeMs + (chunkOffsetSec * 1000) + offsetMs).toISOString();
        } else {
          segmentStart = new Date(baseTimeMs + (chunkOffsetSec * 1000)).toISOString();
        }

        insertTranscriptSegment({
          sessionId,
          trackId,
          burstId: null,
          userId,
          displayName: null,
          speakerLabel: null,
          segmentStart,
          segmentEnd: segmentStart,
          transcript: alt.transcript ?? '',
          confidence: typeof alt.confidence === 'number' ? alt.confidence : null,
          language: config.stt.googleCloud.languageCode,
          isFinal: true,
          sttResultId: `retranscribe_${ci}_${segmentCount}`,
          streamSequence: ci,
          sttEngine: 'google-cloud-stt',
          sttModel: config.stt.googleCloud.model,
        });

        segmentCount++;
      }
    }

    // Clean up chunk file if it's not the main WAV
    if (chunkPath !== wavPath) {
      try { fs.unlinkSync(chunkPath); } catch { /* ignore */ }
    }
  }

  await client.close();
  return segmentCount;
}

/**
 * Diarized transcription: splits audio into chunks, runs recognize() with diarization
 * on each, extracts word-level speaker tags, and groups into per-speaker segments.
 */
async function transcribeWithGoogleCloudDiarized(
  wavPath: string,
  userId: string,
  sessionId: string,
  trackId: number,
  trackStartedAt: string,
  minSpeakers: number,
  maxSpeakers: number,
  tmpDir: string
): Promise<number> {
  const { SpeechClient } = await import('@google-cloud/speech');
  const config = getConfig();
  const client = new SpeechClient({
    projectId: config.stt.googleCloud.projectId || undefined,
    keyFilename: config.stt.googleCloud.keyFile || undefined,
  });

  const baseTimeMs = new Date(trackStartedAt).getTime();
  const durationSec = await getAudioDuration(wavPath);
  console.log(`  Audio duration: ${Math.floor(durationSec / 60)}m ${Math.floor(durationSec % 60)}s`);

  // Split into chunks if longer than the limit
  let chunkPaths: string[];
  let chunkOffsets: number[]; // offset in seconds for each chunk

  if (durationSec <= CHUNK_DURATION_SEC) {
    chunkPaths = [wavPath];
    chunkOffsets = [0];
  } else {
    const chunkDir = path.join(tmpDir, 'chunks');
    if (!fs.existsSync(chunkDir)) {
      fs.mkdirSync(chunkDir, { recursive: true });
    }
    const chunkCount = Math.ceil(durationSec / CHUNK_DURATION_SEC);
    console.log(`  Splitting into ${chunkCount} chunks of ${CHUNK_DURATION_SEC}s each...`);
    chunkPaths = await splitAudioChunks(wavPath, chunkDir, durationSec, CHUNK_DURATION_SEC);
    chunkOffsets = chunkPaths.map((_, i) => i * CHUNK_DURATION_SEC);
  }

  let totalSegments = 0;

  for (let ci = 0; ci < chunkPaths.length; ci++) {
    const chunkPath = chunkPaths[ci];
    const chunkOffsetSec = chunkOffsets[ci];

    if (ci % 20 === 0 || ci === chunkPaths.length - 1) {
      console.log(`  Processing chunk ${ci + 1}/${chunkPaths.length}...`);
    }

    const audioContent = fs.readFileSync(chunkPath);

    const [response] = await client.recognize({
      config: {
        encoding: 'LINEAR16' as const,
        sampleRateHertz: 16000,
        languageCode: config.stt.googleCloud.languageCode,
        model: config.stt.googleCloud.model,
        enableAutomaticPunctuation: config.stt.googleCloud.enableAutomaticPunctuation,
        diarizationConfig: {
          enableSpeakerDiarization: true,
          minSpeakerCount: minSpeakers,
          maxSpeakerCount: maxSpeakers,
        },
        // Phrase hints for character/place name recognition
        ...(config.stt.googleCloud.phraseHints.length > 0 && {
          speechContexts: [{ phrases: config.stt.googleCloud.phraseHints }],
        }),
      },
      audio: { content: audioContent },
    });

    if (!response.results || response.results.length === 0) {
      // Clean up chunk file if it's not the main WAV
      if (chunkPath !== wavPath) {
        try { fs.unlinkSync(chunkPath); } catch { /* ignore */ }
      }
      continue;
    }

    // With diarization, the LAST result contains complete word-level speaker info
    const lastResult = response.results[response.results.length - 1];
    const alt = lastResult?.alternatives?.[0];

    if (!alt?.words || alt.words.length === 0) {
      // No word-level data — fall back to result-level transcript without speaker labels
      for (const result of response.results) {
        if (!result.alternatives?.[0]?.transcript) continue;
        const resultAlt = result.alternatives[0];
        let segmentStart: string;
        if (result.resultEndTime) {
          const offsetMs = (Number(result.resultEndTime.seconds ?? 0) * 1000) +
            Math.floor(Number(result.resultEndTime.nanos ?? 0) / 1_000_000);
          segmentStart = new Date(baseTimeMs + (chunkOffsetSec * 1000) + offsetMs).toISOString();
        } else {
          segmentStart = new Date(baseTimeMs + (chunkOffsetSec * 1000)).toISOString();
        }

        insertTranscriptSegment({
          sessionId,
          trackId,
          burstId: null,
          userId,
          displayName: null,
          speakerLabel: null,
          segmentStart,
          segmentEnd: segmentStart,
          transcript: resultAlt.transcript ?? '',
          confidence: typeof resultAlt.confidence === 'number' ? resultAlt.confidence : null,
          language: config.stt.googleCloud.languageCode,
          isFinal: true,
          sttResultId: `retranscribe_diar_${ci}_${totalSegments}`,
          streamSequence: ci,
          sttEngine: 'google-cloud-stt-diarized',
          sttModel: config.stt.googleCloud.model,
        });
        totalSegments++;
      }
    } else {
      // Group consecutive words by speaker tag into segments
      const segments = groupWordsBySpeaker(alt.words, baseTimeMs, chunkOffsetSec);

      for (const seg of segments) {
        insertTranscriptSegment({
          sessionId,
          trackId,
          burstId: null,
          userId,
          displayName: null,
          speakerLabel: seg.speakerLabel,
          segmentStart: seg.startTime,
          segmentEnd: seg.endTime,
          transcript: seg.transcript,
          confidence: seg.confidence,
          language: config.stt.googleCloud.languageCode,
          isFinal: true,
          sttResultId: `retranscribe_diar_${ci}_${totalSegments}`,
          streamSequence: ci,
          sttEngine: 'google-cloud-stt-diarized',
          sttModel: config.stt.googleCloud.model,
        });
        totalSegments++;
      }
    }

    // Clean up chunk file if it's not the main WAV
    if (chunkPath !== wavPath) {
      try { fs.unlinkSync(chunkPath); } catch { /* ignore */ }
    }
  }

  await client.close();
  return totalSegments;
}

interface WordInfo {
  word?: string | null;
  startTime?: { seconds?: string | number | Long | null; nanos?: number | null } | null;
  endTime?: { seconds?: string | number | Long | null; nanos?: number | null } | null;
  speakerTag?: number | null;
  confidence?: number | null;
}

// google-protobuf Long type
interface Long {
  toNumber(): number;
}

interface SpeakerSegment {
  speakerLabel: string;
  transcript: string;
  startTime: string;
  endTime: string;
  confidence: number | null;
}

function protoTimeToMs(time: { seconds?: string | number | Long | null; nanos?: number | null } | null | undefined): number {
  if (!time) return 0;
  let seconds: number;
  if (typeof time.seconds === 'number') {
    seconds = time.seconds;
  } else if (typeof time.seconds === 'string') {
    seconds = parseInt(time.seconds, 10);
  } else if (time.seconds && typeof (time.seconds as Long).toNumber === 'function') {
    seconds = (time.seconds as Long).toNumber();
  } else {
    seconds = 0;
  }
  const nanos = Number(time.nanos ?? 0);
  return (seconds * 1000) + Math.floor(nanos / 1_000_000);
}

/** Group consecutive words with the same speaker tag into segments. */
function groupWordsBySpeaker(words: WordInfo[], baseTimeMs: number, chunkOffsetSec: number): SpeakerSegment[] {
  const segments: SpeakerSegment[] = [];
  const chunkOffsetMs = chunkOffsetSec * 1000;

  let currentSpeaker: number | null = null;
  let currentWords: string[] = [];
  let segStartMs = 0;
  let segEndMs = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;

  for (const w of words) {
    const speaker = typeof w.speakerTag === 'number' && w.speakerTag > 0 ? w.speakerTag : 0;
    const wordText = (w.word ?? '').trim();
    if (!wordText) continue;

    const wordStartMs = protoTimeToMs(w.startTime);
    const wordEndMs = protoTimeToMs(w.endTime);

    if (speaker !== currentSpeaker && currentWords.length > 0) {
      // Flush current segment
      segments.push({
        speakerLabel: currentSpeaker ? `speaker_${currentSpeaker}` : 'unknown',
        transcript: currentWords.join(' '),
        startTime: new Date(baseTimeMs + chunkOffsetMs + segStartMs).toISOString(),
        endTime: new Date(baseTimeMs + chunkOffsetMs + segEndMs).toISOString(),
        confidence: confidenceCount > 0 ? confidenceSum / confidenceCount : null,
      });
      currentWords = [];
      confidenceSum = 0;
      confidenceCount = 0;
    }

    if (currentWords.length === 0) {
      segStartMs = wordStartMs;
    }
    currentSpeaker = speaker;
    currentWords.push(wordText);
    segEndMs = wordEndMs || wordStartMs;

    if (typeof w.confidence === 'number') {
      confidenceSum += w.confidence;
      confidenceCount++;
    }
  }

  // Flush last segment
  if (currentWords.length > 0) {
    segments.push({
      speakerLabel: currentSpeaker ? `speaker_${currentSpeaker}` : 'unknown',
      transcript: currentWords.join(' '),
      startTime: new Date(baseTimeMs + chunkOffsetMs + segStartMs).toISOString(),
      endTime: new Date(baseTimeMs + chunkOffsetMs + segEndMs).toISOString(),
      confidence: confidenceCount > 0 ? confidenceSum / confidenceCount : null,
    });
  }

  return segments;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  const sessionId = args[0];
  let engine = 'google-cloud-stt';
  let diarized = false;
  let minSpeakers: number | null = null;
  let maxSpeakers: number | null = null;
  let clearExisting = false;

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--engine':
        engine = args[++i];
        break;
      case '--diarized':
        diarized = true;
        break;
      case '--min-speakers':
        minSpeakers = parseInt(args[++i], 10);
        break;
      case '--max-speakers':
        maxSpeakers = parseInt(args[++i], 10);
        break;
      case '--clear':
        clearExisting = true;
        break;
      default:
        if (args[i].startsWith('--')) {
          console.error(`Unknown option: ${args[i]}`);
          usage();
        }
    }
  }

  if (!['whisper', 'google-cloud-stt', 'gemini'].includes(engine)) {
    console.error(`Unknown engine: ${engine}`);
    usage();
  }

  if (diarized && engine !== 'google-cloud-stt') {
    console.error('Diarization is only supported with the google-cloud-stt engine.');
    process.exit(1);
  }

  const modeLabel = diarized ? `${engine} (diarized)` : engine;
  console.log(`Re-transcribing session ${sessionId} with engine: ${modeLabel}`);

  initDb();
  const config = getConfig();

  // Resolve diarization speaker counts from config defaults
  const effectiveMinSpeakers = minSpeakers ?? config.stt.diarization.minSpeakers;
  const effectiveMaxSpeakers = maxSpeakers ?? config.stt.diarization.maxSpeakers;
  if (diarized) {
    console.log(`Diarization: ${effectiveMinSpeakers}-${effectiveMaxSpeakers} speakers`);
  }

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

  console.log(`Found ${tracks.length} audio track(s)`);

  // Clear existing segments if requested
  if (clearExisting) {
    const db = getDb();
    const result = db.prepare('DELETE FROM transcript_segments WHERE session_id = ?').run(sessionId);
    console.log(`Cleared ${result.changes} existing transcript segments`);
  }

  // Create temp directory for WAV files
  const tmpDir = path.resolve(config.dataDir, sessionId, '_retranscribe_tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  let totalSegments = 0;

  for (const track of tracks) {
    const oggPath = path.resolve(track.file_path);
    if (!fs.existsSync(oggPath)) {
      console.warn(`Audio file not found: ${oggPath}, skipping track ${track.id}`);
      continue;
    }

    const wavPath = path.join(tmpDir, `track_${track.id}.wav`);

    console.log(`Decoding track ${track.id} (${track.user_id})...`);
    await decodeOggToWav(oggPath, wavPath);

    updateTrackSttStatus(track.id, 'processing');

    let segmentCount = 0;

    switch (engine) {
      case 'google-cloud-stt':
        if (diarized) {
          segmentCount = await transcribeWithGoogleCloudDiarized(
            wavPath, track.user_id, sessionId, track.id, track.started_at,
            effectiveMinSpeakers, effectiveMaxSpeakers, tmpDir
          );
        } else {
          segmentCount = await transcribeWithGoogleCloud(wavPath, track.user_id, sessionId, track.id, track.started_at, tmpDir);
        }
        break;
      case 'whisper':
        console.error('Whisper re-transcription not yet implemented');
        updateTrackSttStatus(track.id, 'pending');
        break;
      case 'gemini':
        console.error('Gemini re-transcription not yet implemented');
        updateTrackSttStatus(track.id, 'pending');
        break;
    }

    // Only mark completed for engines that actually ran
    if (engine === 'google-cloud-stt') {
      updateTrackSttStatus(track.id, 'completed');
    }
    totalSegments += segmentCount;
    console.log(`Track ${track.id}: ${segmentCount} segments`);

    // Clean up WAV
    try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
  }

  // Clean up temp directory (and any remaining files)
  try {
    const remaining = fs.readdirSync(tmpDir);
    for (const f of remaining) {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch { /* ignore */ }
    }
    // Remove chunks subdir if it exists
    const chunksDir = path.join(tmpDir, 'chunks');
    if (fs.existsSync(chunksDir)) {
      try { fs.rmdirSync(chunksDir); } catch { /* ignore */ }
    }
    fs.rmdirSync(tmpDir);
  } catch { /* ignore */ }

  console.log(`\nRe-transcription complete: ${totalSegments} total segments across ${tracks.length} tracks`);

  if (diarized) {
    console.log('\nNote: Speaker labels (speaker_1, speaker_2, ...) may not be consistent across');
    console.log('audio chunks. Use /session map-speaker to assign names to labels, or review');
    console.log('the transcript manually to identify speakers.');
  }
}

main().catch((err) => {
  console.error('Re-transcription failed:', err);
  process.exit(1);
});
