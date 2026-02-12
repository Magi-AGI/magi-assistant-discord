#!/usr/bin/env tsx
/**
 * Post-session re-transcription script.
 *
 * Usage:
 *   npm run retranscribe <session-id> [--engine whisper|google-cloud-stt|gemini]
 *
 * Decodes OGG audio files for a session, runs STT, and stores transcript segments.
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { initDb } from '../src/db/index.js';
import { getConfig } from '../src/config.js';
import {
  getSession,
  getSessionTracks,
  insertTranscriptSegment,
  updateTrackSttStatus,
} from '../src/db/queries.js';

function usage(): never {
  console.log('Usage: npm run retranscribe <session-id> [--engine whisper|google-cloud-stt|gemini]');
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

async function transcribeWithGoogleCloud(
  wavPath: string,
  userId: string,
  sessionId: string,
  trackId: number,
  trackStartedAt: string
): Promise<number> {
  const { SpeechClient } = await import('@google-cloud/speech');
  const config = getConfig();
  const client = new SpeechClient({
    projectId: config.stt.googleCloud.projectId || undefined,
    keyFilename: config.stt.googleCloud.keyFile || undefined,
  });

  const audioContent = fs.readFileSync(wavPath);

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

  let segmentCount = 0;

  if (response.results) {
    for (const result of response.results) {
      if (!result.alternatives || result.alternatives.length === 0) continue;
      const alt = result.alternatives[0];

      // resultEndTime is an offset from the start of the audio, not a Unix timestamp.
      // Convert to absolute timestamp by adding offset to the track's started_at time.
      let segmentStart: string;
      if (result.resultEndTime) {
        const offsetMs = (Number(result.resultEndTime.seconds ?? 0) * 1000) +
          Math.floor(Number(result.resultEndTime.nanos ?? 0) / 1_000_000);
        const baseTime = new Date(trackStartedAt).getTime();
        segmentStart = new Date(baseTime + offsetMs).toISOString();
      } else {
        segmentStart = trackStartedAt;
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
        sttResultId: `retranscribe_${segmentCount}`,
        streamSequence: 0,
        sttEngine: 'google-cloud-stt',
        sttModel: config.stt.googleCloud.model,
      });

      segmentCount++;
    }
  }

  await client.close();
  return segmentCount;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  const sessionId = args[0];
  let engine = 'google-cloud-stt';

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--engine' && args[i + 1]) {
      engine = args[i + 1];
      i++;
    }
  }

  if (!['whisper', 'google-cloud-stt', 'gemini'].includes(engine)) {
    console.error(`Unknown engine: ${engine}`);
    usage();
  }

  console.log(`Re-transcribing session ${sessionId} with engine: ${engine}`);

  initDb();
  const config = getConfig();

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
        segmentCount = await transcribeWithGoogleCloud(wavPath, track.user_id, sessionId, track.id, track.started_at);
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

  // Clean up temp directory
  try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }

  console.log(`\nRe-transcription complete: ${totalSegments} total segments across ${tracks.length} tracks`);
}

main().catch((err) => {
  console.error('Re-transcription failed:', err);
  process.exit(1);
});
