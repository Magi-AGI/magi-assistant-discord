import { type VoiceReceiver } from '@discordjs/voice';
import { type Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import {
  insertAudioTrack,
  updateAudioTrackFilePath,
  setFirstPacketAt,
  endAudioTrack,
  getTrackCountForUser,
  insertTrackPart,
} from '../db/queries.js';
import { OggMuxer } from './ogg-muxer.js';
import { ffmpegRegistry } from '../stt/process-registry.js';

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
  /**
   * Incrementing suffix for rotated .ogg parts. The primary .ogg starts at 0;
   * each rotation (currently only on ffmpeg resampler death mid-session) opens
   * a new numbered file and records it in track_parts so the hydrate script
   * can stitch them back together.
   */
  partNumber: number;
}

/** Manages all audio tracks for a session. */
export class SessionRecorder {
  private tracks = new Map<string, UserTrack>();
  private sessionId: string;
  private sessionDir: string;
  private receiver: VoiceReceiver;
  /**
   * Recent respawn events per user (ms timestamps), for circuit-breaker-style
   * back-off. If ffmpeg keeps dying, we give up respawning and let STT go
   * dormant — the audio track still continues (OGG writer is independent).
   */
  private recentRespawns = new Map<string, number[]>();
  /**
   * Optional hook fired after a successful resampler respawn, so SessionManager
   * can rebind its SttProcessor to the fresh process. If not set, the STT
   * pipeline's lazy rebind on the next onSpeakingStart will pick up the new
   * resampler.
   */
  onResamplerRespawn?: (userId: string) => void;

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

    // Insert track record first to get the unique trackId for filename
    const trackId = insertAudioTrack({
      sessionId: this.sessionId,
      userId,
      filePath: '', // Updated below once we know the trackId
      startedAt: new Date().toISOString(),
    });

    // Use trackId in filename to avoid collisions from concurrent rejoins
    const fileName = `${userId}_${trackNumber}_t${trackId}.ogg`;
    const filePath = path.join(this.sessionDir, fileName);
    updateAudioTrackFilePath(trackId, path.relative(process.cwd(), filePath));

    // Create OGG muxer and file write stream
    const writeStream = fs.createWriteStream(filePath);
    const muxer = new OggMuxer(writeStream);

    // Persist the primary .ogg as part 0 so hydrate/stitch tooling can find it uniformly
    try {
      insertTrackPart({
        trackId,
        partNumber: 0,
        filePath: path.relative(process.cwd(), filePath),
        startedAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.debug(`Track ${trackId}: track_parts insert failed (migration not applied?):`, err);
    }

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
      partNumber: 0,
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
            `Session ${this.sessionId}, track ${track.trackId} (user ${userId}): Opus frame duration ${durationMs}ms != expected 20ms (TOC byte: 0x${tocByte.toString(16)})`
          );
        }
      }

      // Write raw Opus packet to OGG container
      track.muxer.writeOpusPacket(chunk);
      track.frameCount++;

      // Feed raw Opus packet to ffmpeg resampler for STT.
      // If the resampler died (idle watchdog, crash) we reactively respawn so
      // the next speech burst still reaches STT instead of starving the stream
      // into a 408 Request Timeout (2026-04-23 incident).
      let resampler = ffmpegRegistry.get(userId, this.sessionId);
      if (!resampler) {
        resampler = this.respawnResamplerIfAllowed(userId) ?? undefined;
      }
      if (resampler) {
        resampler.writeOpusData(chunk);
      }
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

  /**
   * Respawn an ffmpeg resampler for a user whose existing process died mid-session.
   * Uses a per-user circuit breaker so a persistent failure doesn't hot-loop.
   * Returns the new resampler, or null if respawn was blocked.
   */
  private respawnResamplerIfAllowed(userId: string): import('../stt/ffmpeg-resampler.js').FfmpegResampler | null {
    const now = Date.now();
    const history = (this.recentRespawns.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (history.length >= 3) {
      // Silent drop — warned at the third failure; log at debug to avoid spam
      logger.debug(`SessionRecorder: respawn suppressed for user ${userId} (3 failures/60s)`);
      this.recentRespawns.set(userId, history);
      return null;
    }
    history.push(now);
    this.recentRespawns.set(userId, history);

    const track = this.tracks.get(userId);
    if (!track || track.closed) return null;

    logger.warn(`SessionRecorder: respawning ffmpeg resampler for user ${userId} mid-session (track ${track.trackId})`);
    const resampler = ffmpegRegistry.spawn(userId, this.sessionId, {
      onUnexpectedExit: (ctx) => {
        logger.warn(
          `SessionRecorder: respawned resampler for user ${ctx.userId} also exited ` +
          `(code ${ctx.code}, signal ${ctx.signal}, reason ${ctx.reason ?? 'unknown'}).`
        );
      },
    });
    if (!resampler) {
      if (history.length === 3) {
        logger.warn(
          `SessionRecorder: ffmpeg circuit breaker open for user ${userId} — ` +
          `STT paused for this user. Audio (.ogg) recording is unaffected.`
        );
      }
      return null;
    }

    // Notify upstream so it can rebind the VadGate / STT processor to the new PCM stream.
    try {
      this.onResamplerRespawn?.(userId);
    } catch (err) {
      logger.warn(`SessionRecorder: onResamplerRespawn hook threw for ${userId}:`, err);
    }
    return resampler;
  }

  /**
   * Rotate the .ogg file for a track — close the current part, start a new one,
   * and record the linkage in track_parts. Used when we want to switch to a
   * fresh OGG stream without ending the logical track (e.g., if the OGG writer
   * enters a degraded state).
   */
  rotateTrackFile(userId: string): UserTrack | null {
    const track = this.tracks.get(userId);
    if (!track || track.closed) return null;

    const previousPart = track.partNumber;
    const nextPart = previousPart + 1;

    // Finalize the old part
    try {
      track.muxer.finalize();
      track.writeStream.end();
    } catch (err) {
      logger.warn(`Track ${track.trackId}: error finalizing part ${previousPart}:`, err);
    }

    // Open the new part
    const fileName = `${track.userId}_${track.trackNumber}_t${track.trackId}_p${nextPart}.ogg`;
    const filePath = path.join(this.sessionDir, fileName);
    const writeStream = fs.createWriteStream(filePath);
    const muxer = new OggMuxer(writeStream);

    track.muxer = muxer;
    track.writeStream = writeStream;
    track.filePath = filePath;
    track.partNumber = nextPart;

    try {
      insertTrackPart({
        trackId: track.trackId,
        partNumber: nextPart,
        filePath: path.relative(process.cwd(), filePath),
        startedAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.debug(`Track ${track.trackId}: track_parts insert for part ${nextPart} failed:`, err);
    }

    logger.info(
      `Track ${track.trackId} (user ${userId}): rotated to part ${nextPart} (file: ${fileName})`
    );
    return track;
  }

  /** Close a specific user's track (on leave/disconnect). */
  closeUserTrack(userId: string): void {
    const track = this.tracks.get(userId);
    if (!track || track.closed) return;

    track.closed = true;
    track.stream.destroy();
    track.muxer.finalize();

    // Wait for all buffered data to flush before closing the file
    track.writeStream.end(() => {
      logger.debug(`Track ${track.trackId}: file write stream finished`);
    });

    endAudioTrack(track.trackId, new Date().toISOString());
    this.tracks.delete(userId);
    this.recentRespawns.delete(userId);

    logger.info(
      `Closed track ${track.trackId} for user ${userId}: ${track.frameCount} frames written` +
      (track.partNumber > 0 ? ` across ${track.partNumber + 1} parts` : '')
    );
  }

  /** Close all tracks (session stop or shutdown). */
  closeAll(): void {
    // Snapshot keys since closeUserTrack modifies the map
    const userIds = Array.from(this.tracks.keys());
    for (const userId of userIds) {
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
