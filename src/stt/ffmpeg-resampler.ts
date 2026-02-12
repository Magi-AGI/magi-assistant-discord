import { spawn, type ChildProcess } from 'child_process';
import { type Readable } from 'stream';
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
 * Spawns an ffmpeg subprocess that converts raw Opus packets to 16kHz mono PCM (s16le)
 * suitable for STT engines.
 *
 * Includes:
 * - Idle watchdog (60 min) to catch leaked processes from desynced voice state
 * - Backpressure handling: pauses writes when stdin is full, resumes on drain
 */
export class FfmpegResampler {
  private process: ChildProcess;
  private _alive = true;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  readonly userId: string;

  constructor(userId: string) {
    this.userId = userId;

    this.process = spawn('ffmpeg', [
      '-f', 'opus',
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

  /** Write raw Opus data to ffmpeg stdin. Drops when backpressured. */
  writeOpusData(chunk: Buffer): void {
    if (!this._alive || !this.process.stdin?.writable) return;

    // Drop while paused (backpressure active)
    if (this.paused) return;

    // Reset watchdog on every write (user is still sending audio)
    this.resetWatchdog();

    const ok = this.process.stdin.write(chunk);
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

  /** Gracefully kill the ffmpeg process. */
  kill(): void {
    if (!this._alive) return;
    this._alive = false;
    this.clearWatchdog();

    try {
      this.process.stdin?.end();
      this.process.kill('SIGTERM');
    } catch {
      // Already dead
    }

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
