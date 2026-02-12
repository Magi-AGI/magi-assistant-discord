import { FfmpegResampler } from './ffmpeg-resampler.js';
import { logger } from '../logger.js';

/**
 * Singleton registry of per-user ffmpeg resampler processes.
 * Keys are `sessionId:userId` to avoid cross-session collisions.
 * Convenience overloads accepting just `userId` use a wildcard match for backward compat.
 */
class ProcessRegistry {
  private resamplers = new Map<string, FfmpegResampler>();

  private makeKey(sessionId: string, userId: string): string {
    return `${sessionId}:${userId}`;
  }

  /** Spawn a new resampler for a user in a session, killing any existing one. */
  spawn(userId: string, sessionId?: string): FfmpegResampler {
    const key = sessionId ? this.makeKey(sessionId, userId) : userId;
    this.killByKey(key);
    const resampler = new FfmpegResampler(userId);
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
      existing.kill();
      this.resamplers.delete(key);
    }
  }

  /** Kill all resamplers (for shutdown). */
  killAll(): void {
    for (const [, resampler] of this.resamplers) {
      resampler.kill();
    }
    this.resamplers.clear();
    logger.debug('ffmpeg registry: all resamplers killed');
  }

  /** Get a user's resampler if alive. */
  get(userId: string, sessionId?: string): FfmpegResampler | undefined {
    const key = sessionId ? this.makeKey(sessionId, userId) : this.findKeyForUser(userId);
    if (!key) return undefined;
    const r = this.resamplers.get(key);
    if (r && !r.alive) {
      this.resamplers.delete(key);
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
