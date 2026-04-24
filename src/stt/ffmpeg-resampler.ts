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
 *
 * NOTE (2026-04-23 incident): prior to the fix that added auto-respawn in
 * SessionRecorder, if this watchdog fired mid-session the audio pipeline to
 * STT died silently. The respawn path now keeps the track alive. The watchdog
 * threshold is intentionally kept at 60 minutes — shorter would trigger far
 * more than is useful and longer would leak resources during desynced voice state.
 */
const IDLE_WATCHDOG_MS = 60 * 60 * 1000;

/** Ring-buffer of stderr lines kept so exit diagnostics can surface the actual failure reason. */
const STDERR_RING_SIZE = 32;

/** How long (ms) of stderr output after a non-zero exit counts as "recent" for diagnostics. */
const STDERR_RECENT_MS = 5_000;

/** Reasons ffmpeg commonly exits 255 — mapped from stderr patterns so the log self-explains. */
const STDERR_DIAGNOSTIC_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /Immediate exit requested/i, reason: 'SIGTERM received (killed by this process via .kill() or by OS)' },
  { pattern: /Broken pipe/i, reason: 'stdin closed by parent before ffmpeg finished demuxing' },
  { pattern: /No such file or directory/i, reason: 'binary missing or I/O target unavailable' },
  { pattern: /Invalid data found when processing input/i, reason: 'corrupt PCM input (upstream decoder issue?)' },
  { pattern: /Unknown encoder|Unknown decoder/i, reason: 'ffmpeg build missing required codec' },
  { pattern: /Permission denied/i, reason: 'sandbox or AppArmor blocked a syscall' },
  { pattern: /Killed/i, reason: 'killed by the OS (OOM?)' },
];

export interface StderrEntry {
  ts: number;
  line: string;
}

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
 * - stderr ring buffer so non-zero exits surface the real reason, not just
 *   the "Immediate exit requested" banner that ffmpeg prints in reaction to
 *   SIGTERM.
 */
export class FfmpegResampler {
  private process: ChildProcess;
  private opusDecoder: OpusEncoder;
  private _alive = true;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  /**
   * Rolling window of recent stderr output. Plain warnings (ffmpeg header lines)
   * are captured too — on a crash we need the full tail, not just the lines the
   * original filter caught.
   */
  private stderrRing: StderrEntry[] = [];
  /** The resolved exit reason, populated on exit for callers that want to surface it. */
  private _exitReason: string | null = null;
  /** Exit handlers — fired after _alive is set to false so upstream can respawn. */
  private exitHandlers: Array<(info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string; reason: string | null }) => void> = [];
  /** Set once we've emitted the on-exit diagnostics, so stdin 'error' handler doesn't double-log. */
  private exitLogged = false;
  readonly userId: string;

  constructor(userId: string) {
    this.userId = userId;

    // Discord sends 48kHz stereo Opus — decode to PCM first
    this.opusDecoder = new OpusEncoder(48000, 2);

    // ffmpeg receives raw PCM (48kHz stereo s16le) and resamples to 16kHz mono
    this.process = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
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
      const raw = data.toString();
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.stderrRing.push({ ts: Date.now(), line: trimmed });
        if (this.stderrRing.length > STDERR_RING_SIZE) {
          this.stderrRing.shift();
        }
      }
      // Log only warnings/errors inline so the journal isn't flooded with header lines
      const msg = raw.trim();
      if (msg.includes('Error') || msg.includes('error') || msg.includes('Warning')) {
        logger.warn(`ffmpeg resampler (${userId}): ${msg}`);
      }
    });

    this.process.on('exit', (code, signal) => {
      this._alive = false;
      this.clearWatchdog();
      this.logExit(code, signal);
      this.fireExitHandlers(code, signal);
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

  /**
   * Write raw PCM (48 kHz stereo s16le) directly to ffmpeg's stdin, bypassing
   * the Opus decode step. Intended for preflight synthetic-silence tests and
   * any integration harness that doesn't want to mint valid Opus frames.
   * Returns false if the write failed (process dead).
   */
  writeRawPcm(chunk: Buffer): boolean {
    if (!this._alive || !this.process.stdin?.writable) return false;
    this.resetWatchdog();
    try {
      const ok = this.process.stdin.write(chunk);
      if (!ok) {
        this.paused = true;
      }
      return ok;
    } catch {
      this._alive = false;
      return false;
    }
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

  /** Populated on exit; null while the process is still running or if it exited 0 cleanly. */
  get exitReason(): string | null {
    return this._exitReason;
  }

  /**
   * Register a handler that fires once after the ffmpeg process exits.
   * Handlers receive the exit code, signal, recent stderr tail, and a best-effort
   * diagnostic reason so upstream (SessionRecorder) can decide whether to respawn.
   */
  onExit(handler: (info: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string; reason: string | null }) => void): void {
    // If already exited, invoke synchronously on next tick to match async semantics
    if (!this._alive) {
      setImmediate(() => handler({
        code: this.process.exitCode,
        signal: this.process.signalCode,
        stderrTail: this.getRecentStderr(),
        reason: this._exitReason,
      }));
      return;
    }
    this.exitHandlers.push(handler);
  }

  /** Join the ring buffer into a tail string (newline-delimited). */
  private getRecentStderr(): string {
    const cutoff = Date.now() - STDERR_RECENT_MS;
    const recent = this.stderrRing.filter((e) => e.ts >= cutoff);
    // Always include at least the last 4 entries even if older than the cutoff —
    // short sessions can exit fast with stderr emitted right at spawn.
    const merged = recent.length >= 4 ? recent : this.stderrRing.slice(-4);
    return merged.map((e) => e.line).join('\n');
  }

  /** Best-effort reason resolution from the stderr tail. */
  private resolveExitReason(code: number | null, signal: NodeJS.Signals | null): string | null {
    if (code === 0 && !signal) return null;

    const tail = this.getRecentStderr();
    for (const { pattern, reason } of STDERR_DIAGNOSTIC_PATTERNS) {
      if (pattern.test(tail)) return reason;
    }
    if (signal === 'SIGTERM') return 'SIGTERM (killed by .kill() or OS)';
    if (signal === 'SIGKILL') return 'SIGKILL (force-killed, likely post-SIGTERM fallback or OOM)';
    if (code === 255) return 'exit 255 with no matching stderr pattern — likely SIGTERM received before stderr flushed';
    if (code !== null && code !== 0) return `exit code ${code} with no matching stderr pattern`;
    return null;
  }

  private logExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitLogged) return;
    this.exitLogged = true;

    const reason = this.resolveExitReason(code, signal);
    this._exitReason = reason;

    if (code === 0 && !signal) {
      // Clean exit — debug only
      logger.debug(`ffmpeg resampler (${this.userId}): exited cleanly`);
      return;
    }

    const tail = this.getRecentStderr();
    const tailLine = tail ? `\n  stderr-tail:\n    ${tail.split('\n').join('\n    ')}` : '\n  stderr-tail: <empty>';
    const reasonLine = reason ? `\n  resolved-reason: ${reason}` : '';
    logger.warn(
      `ffmpeg resampler (${this.userId}): exited with code ${code}, signal ${signal}${reasonLine}${tailLine}`
    );
  }

  private fireExitHandlers(code: number | null, signal: NodeJS.Signals | null): void {
    const info = {
      code,
      signal,
      stderrTail: this.getRecentStderr(),
      reason: this._exitReason,
    };
    const handlers = this.exitHandlers.slice();
    this.exitHandlers.length = 0;
    for (const handler of handlers) {
      try {
        handler(info);
      } catch (err) {
        logger.warn(`ffmpeg resampler (${this.userId}): onExit handler threw:`, err);
      }
    }
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
        logger.warn(
          `ffmpeg resampler (${this.userId}): idle watchdog fired after ${IDLE_WATCHDOG_MS / 1000}s — ` +
          `force-killing (no audio written for 60 min; resampler will respawn on next speech)`
        );
        this._exitReason = 'idle watchdog (60 min no writes)';
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
