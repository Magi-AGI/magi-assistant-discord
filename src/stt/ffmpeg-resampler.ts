import { spawn, type ChildProcess } from 'child_process';
import { type Readable } from 'stream';
import { OpusEncoder } from '@discordjs/opus';
import { logger } from '../logger.js';

/**
 * 60 minutes — if no audio is written for this long, force-kill the process.
 * Set high because normal TTRPG silence periods (bathroom breaks, reading rules,
 * long combat sequences) can easily exceed 10-30 minutes. The primary cleanup
 * path for legitimate disconnects is the voiceStateUpdate handler, not this
 * watchdog. This is a safety net for desynced voice state only.
 */
const IDLE_WATCHDOG_MS = 60 * 60 * 1000;

/**
 * Decodes raw Opus packets to PCM via @discordjs/opus, then resamples
 * from 48kHz stereo to 16kHz mono via ffmpeg (s16le throughout).
 *
 * Two-stage pipeline avoids the `-f opus` demuxer which isn't available
 * in most ffmpeg builds (raw Opus demuxer != Ogg/Opus).
 *
 * Includes:
 * - Idle watchdog (60 min) to catch leaked processes from desynced voice state
 * - Backpressure handling: pauses writes when stdin is full, resumes on drain
 */
export class FfmpegResampler {
  private process: ChildProcess;
  private opusDecoder: OpusEncoder;
  private _alive = true;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  readonly userId: string;

  constructor(userId: string) {
    this.userId = userId;

    // Discord sends 48kHz stereo Opus — decode to PCM first
    this.opusDecoder = new OpusEncoder(48000, 2);

    // ffmpeg receives raw PCM (48kHz stereo s16le) and resamples to 16kHz mono
    this.process = spawn('ffmpeg', [
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      '-i', 'pipe:0',
      '-ar', '16000',
      '-ac', '1',
      '-f', 's16le',
      'pipe:1',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      // Only log warnings/errors, not the normal ffmpeg header
      if (msg.includes('Error') || msg.includes('error') || msg.includes('Warning')) {
        logger.warn(`ffmpeg resampler (${userId}): ${msg}`);
      }
    });

    this.process.on('exit', (code, signal) => {
      this._alive = false;
      this.clearWatchdog();
      if (code !== 0 && code !== null && signal !== 'SIGTERM') {
        logger.warn(`ffmpeg resampler (${userId}): exited with code ${code}, signal ${signal}`);
      }
    });

    this.process.on('error', (err) => {
      this._alive = false;
      this.clearWatchdog();
      logger.error(`ffmpeg resampler (${userId}): spawn error:`, err);
    });

    // Handle async EPIPE errors on stdin (not caught by write() try/catch)
    this.process.stdin?.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'EPIPE') {
        this._alive = false;
        logger.debug(`ffmpeg resampler (${this.userId}): stdin EPIPE — ffmpeg process exited`);
      } else {
        logger.warn(`ffmpeg resampler (${this.userId}): stdin error:`, err);
      }
    });

    // Resume writes when stdin drains
    this.process.stdin?.on('drain', () => {
      if (this.paused) {
        this.paused = false;
        logger.debug(`ffmpeg resampler (${this.userId}): stdin drained, resuming writes`);
      }
    });

    // Start idle watchdog
    this.resetWatchdog();

    logger.debug(`ffmpeg resampler spawned for user ${userId}, pid=${this.process.pid}`);
  }

  /** Write raw Opus data — decodes to PCM then pipes to ffmpeg. Drops when backpressured. */
  writeOpusData(chunk: Buffer): void {
    if (!this._alive || !this.process.stdin?.writable) return;

    // Drop while paused (backpressure active)
    if (this.paused) return;

    // Reset watchdog on every write (user is still sending audio)
    this.resetWatchdog();

    // Decode Opus packet to PCM
    let pcm: Buffer;
    try {
      pcm = this.opusDecoder.decode(chunk);
    } catch {
      // Corrupted or unsupported Opus packet — skip it
      return;
    }

    let ok: boolean;
    try {
      ok = this.process.stdin.write(pcm);
    } catch {
      // Broken pipe / destroyed stream — mark dead and stop writing
      this._alive = false;
      return;
    }
    if (!ok) {
      // Backpressure — pause until drain event
      this.paused = true;
      logger.debug(`ffmpeg resampler (${this.userId}): backpressure, pausing writes until drain`);
    }
  }

  /** Readable stream of 16kHz mono s16le PCM output. */
  get pcmOutput(): Readable {
    return this.process.stdout as Readable;
  }

  get alive(): boolean {
    return this._alive;
  }

  /** Gracefully kill the ffmpeg process. Two-stage: SIGTERM, then SIGKILL after 2s. */
  kill(): void {
    if (!this._alive) return;
    this._alive = false;
    this.clearWatchdog();

    try {
      this.process.stdin?.end();
      this.process.kill('SIGTERM');
    } catch {
      // Already dead
      return;
    }

    // SIGKILL fallback: if process hasn't exited after 2s, force kill
    const sigkillTimer = setTimeout(() => {
      // Verify process hasn't already exited (prevents PID reuse race)
      if (this.process.exitCode !== null || this.process.signalCode !== null) return;
      try {
        this.process.kill('SIGKILL');
        logger.warn(`ffmpeg resampler (${this.userId}): SIGTERM ignored, sent SIGKILL (pid=${this.process.pid})`);
      } catch {
        // Already exited — good
      }
    }, 2000);

    // Clear fallback timer if process exits normally
    this.process.once('exit', () => {
      clearTimeout(sigkillTimer);
    });

    logger.debug(`ffmpeg resampler killed for user ${this.userId}`);
  }

  private resetWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
    }
    this.watchdogTimer = setTimeout(() => {
      if (this._alive) {
        logger.warn(`ffmpeg resampler (${this.userId}): idle watchdog fired after ${IDLE_WATCHDOG_MS / 1000}s — force-killing`);
        this.kill();
      }
    }, IDLE_WATCHDOG_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}
