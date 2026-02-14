import { FfmpegResampler } from './ffmpeg-resampler.js';
import { logger } from '../logger.js';

/**
 * Singleton registry of per-user ffmpeg resampler processes.
 * Keys are `sessionId:userId` to avoid cross-session collisions.
 * Convenience overloads accepting just `userId` use a wildcard match for backward compat.
 *
 * Includes a circuit breaker: if ffmpeg fails to spawn 3 times within 60s
 * for a given key, further spawn attempts are blocked until the window expires.
 */
const BREAKER_WINDOW_MS = 60_000;
const BREAKER_MAX_FAILURES = 3;

class ProcessRegistry {
  private resamplers = new Map<string, FfmpegResampler>();
  private spawnFailures = new Map<string, number[]>();
  private earlyExitListeners = new Map<string, () => void>();

  private makeKey(sessionId: string, userId: string): string {
    return `${sessionId}:${userId}`;
  }

  /** Spawn a new resampler for a user in a session, killing any existing one. */
  spawn(userId: string, sessionId?: string): FfmpegResampler | null {
    const key = sessionId ? this.makeKey(sessionId, userId) : userId;

    // Circuit breaker: check recent failures
    const now = Date.now();
    const failures = (this.spawnFailures.get(key) ?? []).filter((t) => now - t < BREAKER_WINDOW_MS);
    this.spawnFailures.set(key, failures);

    if (failures.length >= BREAKER_MAX_FAILURES) {
      logger.warn(`ffmpeg registry: circuit breaker open for ${key} — skipping spawn`);
      return null;
    }

    this.killByKey(key);
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

    this.resamplers.set(key, resampler);
    return resampler;
  }

  /** Kill a specific user's resampler. */
  kill(userId: string, sessionId?: string): void {
    if (sessionId) {
      this.killByKey(this.makeKey(sessionId, userId));
    } else {
      // Kill any key ending with this userId (backward compat)
      for (const [key] of this.resamplers) {
        if (key === userId || key.endsWith(`:${userId}`)) {
          this.killByKey(key);
        }
      }
    }
  }

  private killByKey(key: string): void {
    const existing = this.resamplers.get(key);
    if (existing) {
      // Remove early-exit listener before intentional kill to avoid false circuit breaker trips
      const listener = this.earlyExitListeners.get(key);
      if (listener) {
        existing.pcmOutput.removeListener('close', listener);
        this.earlyExitListeners.delete(key);
      }
      existing.kill();
      this.resamplers.delete(key);
    }
  }

  /** Kill all resamplers (for shutdown). */
  killAll(): void {
    for (const [key, resampler] of this.resamplers) {
      // Remove early-exit listener before intentional kill
      const listener = this.earlyExitListeners.get(key);
      if (listener) {
        resampler.pcmOutput.removeListener('close', listener);
      }
      resampler.kill();
    }
    this.resamplers.clear();
    this.earlyExitListeners.clear();
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
