import { type VoiceReceiver } from '@discordjs/voice';
import { type Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import {
  insertAudioTrack,
  setFirstPacketAt,
  endAudioTrack,
  getTrackCountForUser,
} from '../db/queries.js';
import { OggMuxer } from './ogg-muxer.js';

/**
 * Parse the Opus TOC byte to extract the frame duration.
 * The TOC byte encodes config (5 bits), stereo flag (1 bit), and frame count code (2 bits).
 * Frame duration is derived from the config field.
 *
 * Returns the duration in ms of a single Opus frame.
 */
function getOpusFrameDurationMs(tocByte: number): number {
  const config = (tocByte >> 3) & 0x1f;

  if (config <= 3) {
    // SILK-only: 10, 20, 40, 60 ms
    return [10, 20, 40, 60][config];
  }
  if (config <= 7) {
    // SILK-only: 10, 20, 40, 60 ms
    return [10, 20, 40, 60][config - 4];
  }
  if (config <= 11) {
    // SILK-only: 10, 20, 40, 60 ms
    return [10, 20, 40, 60][config - 8];
  }
  if (config === 12 || config === 13) {
    // Hybrid: 10, 20 ms
    return config === 12 ? 10 : 20;
  }
  if (config === 14 || config === 15) {
    // Hybrid: 10, 20 ms
    return config === 14 ? 10 : 20;
  }
  if (config <= 19) {
    // CELT-only: 2.5, 5, 10, 20 ms
    return [2.5, 5, 10, 20][config - 16];
  }
  if (config <= 23) {
    // CELT-only: 2.5, 5, 10, 20 ms
    return [2.5, 5, 10, 20][config - 20];
  }
  if (config <= 27) {
    // CELT-only: 2.5, 5, 10, 20 ms
    return [2.5, 5, 10, 20][config - 24];
  }
  if (config <= 31) {
    // CELT-only: 2.5, 5, 10, 20 ms
    return [2.5, 5, 10, 20][config - 28];
  }
  return 20; // Fallback
}

/** Per-user audio track state. */
export interface UserTrack {
  userId: string;
  trackId: number;
  trackNumber: number;
  filePath: string;
  stream: Readable;
  muxer: OggMuxer;
  writeStream: fs.WriteStream;
  frameCount: number;
  firstPacketRecorded: boolean;
  closed: boolean;
}

/** Manages all audio tracks for a session. */
export class SessionRecorder {
  private tracks = new Map<string, UserTrack>();
  private sessionId: string;
  private sessionDir: string;
  private receiver: VoiceReceiver;

  constructor(sessionId: string, receiver: VoiceReceiver) {
    this.sessionId = sessionId;
    this.receiver = receiver;
    const config = getConfig();
    this.sessionDir = path.resolve(config.dataDir, sessionId);
  }

  /** Subscribe to a user's audio stream and begin recording. */
  subscribeUser(userId: string): UserTrack | null {
    // Don't double-subscribe
    if (this.tracks.has(userId) && !this.tracks.get(userId)!.closed) {
      return this.tracks.get(userId)!;
    }

    const trackNumber = getTrackCountForUser(this.sessionId, userId);
    const fileName = `${userId}_${trackNumber}.ogg`;
    const filePath = path.join(this.sessionDir, fileName);

    // Insert track record
    const trackId = insertAudioTrack({
      sessionId: this.sessionId,
      userId,
      filePath: path.relative(process.cwd(), filePath),
      startedAt: new Date().toISOString(),
    });

    // Create OGG muxer and file write stream
    const writeStream = fs.createWriteStream(filePath);
    const muxer = new OggMuxer(writeStream);

    // Subscribe to the user's audio -- keep open (no EndBehaviorType.AfterSilence)
    const audioStream = this.receiver.subscribe(userId);

    const track: UserTrack = {
      userId,
      trackId,
      trackNumber,
      filePath,
      stream: audioStream,
      muxer,
      writeStream,
      frameCount: 0,
      firstPacketRecorded: false,
      closed: false,
    };

    // Process each audio packet
    audioStream.on('data', (chunk: Buffer) => {
      if (track.closed) return;

      // Record first packet wall-clock time
      if (!track.firstPacketRecorded) {
        const now = new Date().toISOString();
        setFirstPacketAt(track.trackId, now);
        track.firstPacketRecorded = true;
        logger.debug(`Track ${track.trackId}: first packet at ${now}`);
      }

      // TOC byte guard: check frame duration before muxing
      if (chunk.length > 0) {
        const tocByte = chunk[0];
        const durationMs = getOpusFrameDurationMs(tocByte);
        if (durationMs !== 20) {
          logger.warn(
            `Track ${track.trackId} (user ${userId}): Opus frame duration ${durationMs}ms != expected 20ms (TOC byte: 0x${tocByte.toString(16)})`
          );
        }
      }

      // Write raw Opus packet to OGG container
      muxer.writeOpusPacket(chunk);
      track.frameCount++;
    });

    audioStream.on('error', (err) => {
      logger.error(`Audio stream error for user ${userId}, track ${track.trackId}:`, err);
    });

    audioStream.on('end', () => {
      logger.debug(`Audio stream ended for user ${userId}, track ${track.trackId}`);
      // Don't close here -- stream end doesn't mean the user left.
      // We close explicitly on user leave or session stop.
    });

    this.tracks.set(userId, track);
    logger.info(`Subscribed to audio for user ${userId}, track ${track.trackId} (file: ${fileName})`);
    return track;
  }

  /** Close a specific user's track (on leave/disconnect). */
  closeUserTrack(userId: string): void {
    const track = this.tracks.get(userId);
    if (!track || track.closed) return;

    track.closed = true;
    track.stream.destroy();
    track.muxer.finalize();
    track.writeStream.end();

    endAudioTrack(track.trackId, new Date().toISOString());
    this.tracks.delete(userId);

    logger.info(
      `Closed track ${track.trackId} for user ${userId}: ${track.frameCount} frames written`
    );
  }

  /** Close all tracks (session stop or shutdown). */
  closeAll(): void {
    for (const [userId] of this.tracks) {
      this.closeUserTrack(userId);
    }
  }

  /** Get the track for a user (if active). */
  getTrack(userId: string): UserTrack | undefined {
    const track = this.tracks.get(userId);
    return track && !track.closed ? track : undefined;
  }

  /** Get all active tracks. */
  getAllTracks(): UserTrack[] {
    return Array.from(this.tracks.values()).filter((t) => !t.closed);
  }
}
