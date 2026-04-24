import { FfmpegResampler } from './ffmpeg-resampler.js';
import { logger } from '../logger.js';

/**
 * Singleton registry of per-user ffmpeg resampler processes.
 * Keys are `sessionId:userId` to avoid cross-session collisions.
 * Convenience overloads accepting just `userId` use a wildcard match for backward compat.
 *
 * Includes a circuit breaker: if ffmpeg fails to spawn 3 times within 60s
 * for a given key, further spawn attempts are blocked until the window expires.
 *
 * Also supports opt-in auto-respawn on unexpected exit (2026-04-23 incident fix):
 * a caller can register a `respawnHandler` on construction; if ffmpeg exits
 * for any reason other than an intentional kill-through-the-registry, the
 * handler is invoked so STT + audio pipelines can rebuild around a fresh process.
 */
const BREAKER_WINDOW_MS = 60_000;
const BREAKER_MAX_FAILURES = 3;

export interface RespawnContext {
  userId: string;
  sessionId: string;
  /** Reason resolved from ffmpeg stderr (e.g. "idle watchdog", "SIGKILL (OOM?)"). */
  reason: string | null;
  /** Exit code / signal, for logging. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}

export type RespawnHandler = (ctx: RespawnContext) => void;

class ProcessRegistry {
  private resamplers = new Map<string, FfmpegResampler>();
  private spawnFailures = new Map<string, number[]>();
  private earlyExitListeners = new Map<string, () => void>();
  /** Keys we intentionally killed — used to suppress the respawn handler for clean kills. */
  private intentionalKills = new Set<string>();
  /** Per-key respawn handlers. Populated via spawn(userId, sessionId, { onUnexpectedExit }). */
  private respawnHandlers = new Map<string, RespawnHandler>();

  private makeKey(sessionId: string, userId: string): string {
    return `${sessionId}:${userId}`;
  }

  /**
   * Spawn a new resampler for a user in a session, killing any existing one.
   * Callers can register an `onUnexpectedExit` handler to be notified when the
   * ffmpeg process exits for any reason other than an intentional kill via
   * this registry (kill / killByKey / killAll). Used by SessionRecorder to
   * respawn after idle-watchdog timeouts or ffmpeg crashes mid-session.
   */
  spawn(
    userId: string,
    sessionId?: string,
    options: { onUnexpectedExit?: RespawnHandler } = {}
  ): FfmpegResampler | null {
    const key = sessionId ? this.makeKey(sessionId, userId) : userId;

    // Circuit breaker: check recent failures
    const now = Date.now();
    const failures = (this.spawnFailures.get(key) ?? []).filter((t) => now - t < BREAKER_WINDOW_MS);
    this.spawnFailures.set(key, failures);

    if (failures.length >= BREAKER_MAX_FAILURES) {
      logger.warn(`ffmpeg registry: circuit breaker open for ${key} — skipping spawn`);
      return null;
    }

    this.killByKey(key, { intentional: true });
    const resampler = new FfmpegResampler(userId);

    // Record failure if process dies within 2s (missing binary, permissions, etc.)
    const spawnTime = Date.now();
    const onEarlyExit = () => {
      if (Date.now() - spawnTime < 2000) {
        failures.push(Date.now());
        this.spawnFailures.set(key, failures);
        logger.warn(`ffmpeg registry: early exit detected for ${key} (${failures.length}/${BREAKER_MAX_FAILURES} failures)`);
      }
    };
    resampler.pcmOutput.once('close', onEarlyExit);
    this.earlyExitListeners.set(key, onEarlyExit);

    // Register respawn handler BEFORE the process can exit to avoid races.
    if (options.onUnexpectedExit && sessionId) {
      this.respawnHandlers.set(key, options.onUnexpectedExit);
      resampler.onExit((info) => {
        // If the registry killed this resampler on purpose, suppress respawn.
        if (this.intentionalKills.has(key)) {
          this.intentionalKills.delete(key);
          return;
        }
        const handler = this.respawnHandlers.get(key);
        if (!handler) return;
        // Scrub handler after firing so double-kills don't re-run it.
        this.respawnHandlers.delete(key);
        try {
          handler({
            userId,
            sessionId,
            reason: info.reason,
            code: info.code,
            signal: info.signal,
            stderrTail: info.stderrTail,
          });
        } catch (err) {
          logger.warn(`ffmpeg registry: respawn handler threw for ${key}:`, err);
        }
      });
    }

    this.resamplers.set(key, resampler);
    return resampler;
  }

  /** Kill a specific user's resampler. */
  kill(userId: string, sessionId?: string): void {
    if (sessionId) {
      this.killByKey(this.makeKey(sessionId, userId), { intentional: true });
    } else {
      // Kill any key ending with this userId (backward compat)
      for (const [key] of this.resamplers) {
        if (key === userId || key.endsWith(`:${userId}`)) {
          this.killByKey(key, { intentional: true });
        }
      }
    }
  }

  private killByKey(key: string, opts: { intentional: boolean } = { intentional: false }): void {
    const existing = this.resamplers.get(key);
    if (existing) {
      if (opts.intentional) {
        this.intentionalKills.add(key);
      }
      // Remove early-exit listener before intentional kill to avoid false circuit breaker trips
      const listener = this.earlyExitListeners.get(key);
      if (listener) {
        existing.pcmOutput.removeListener('close', listener);
        this.earlyExitListeners.delete(key);
      }
      // Scrub respawn handler on intentional kill — we don't want the killer's
      // callback to fire when they explicitly asked for shutdown.
      if (opts.intentional) {
        this.respawnHandlers.delete(key);
      }
      existing.kill();
      this.resamplers.delete(key);
    }
  }

  /** Kill all resamplers (for shutdown). */
  killAll(): void {
    for (const [key, resampler] of this.resamplers) {
      this.intentionalKills.add(key);
      // Remove early-exit listener before intentional kill
      const listener = this.earlyExitListeners.get(key);
      if (listener) {
        resampler.pcmOutput.removeListener('close', listener);
      }
      resampler.kill();
    }
    this.resamplers.clear();
    this.earlyExitListeners.clear();
    this.respawnHandlers.clear();
    logger.debug('ffmpeg registry: all resamplers killed');
  }

  /** Get a user's resampler if alive. */
  get(userId: string, sessionId?: string): FfmpegResampler | undefined {
    const key = sessionId ? this.makeKey(sessionId, userId) : this.findKeyForUser(userId);
    if (!key) return undefined;
    const r = this.resamplers.get(key);
    if (r && !r.alive) {
      this.resamplers.delete(key);
      this.earlyExitListeners.delete(key);
      return undefined;
    }
    return r;
  }

  private findKeyForUser(userId: string): string | undefined {
    // Check exact match first (legacy keys without session prefix)
    if (this.resamplers.has(userId)) return userId;
    // Then check session-scoped keys
    for (const key of this.resamplers.keys()) {
      if (key.endsWith(`:${userId}`)) return key;
    }
    return undefined;
  }

  get size(): number {
    return this.resamplers.size;
  }
}

export const ffmpegRegistry = new ProcessRegistry();
