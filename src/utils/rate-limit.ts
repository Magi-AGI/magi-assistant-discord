import { logger } from '../logger.js';

/** Maximum Retry-After we'll honor before aborting (60 seconds). */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Retry a function with exponential backoff on 429 (rate limit) errors.
 * Respects Retry-After headers: uses server-specified delay when available,
 * aborts immediately if Retry-After exceeds 60 seconds (prevents hammering
 * a long-banned endpoint).
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const isRateLimit = err instanceof Error &&
        'status' in err && (err as { status: number }).status === 429;

      if (!isRateLimit || attempt === maxAttempts) {
        throw err;
      }

      // Extract Retry-After from error (discord.js attaches retryAfter in ms on DiscordAPIError)
      const retryAfterMs = extractRetryAfter(err);

      // If the server says "come back in > 60s", don't retry — abort immediately
      if (retryAfterMs !== null && retryAfterMs > MAX_RETRY_AFTER_MS) {
        logger.warn(`Rate limited with Retry-After ${retryAfterMs}ms (> ${MAX_RETRY_AFTER_MS}ms cap), aborting`);
        throw err;
      }

      const delayMs = retryAfterMs ?? Math.pow(2, attempt - 1) * 1000;
      logger.warn(`Rate limited (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/** Extract Retry-After from a discord.js DiscordAPIError or similar. Returns ms or null. */
function extractRetryAfter(err: unknown): number | null {
  if (err && typeof err === 'object') {
    // discord.js DiscordAPIError exposes retryAfter in milliseconds
    if ('retryAfter' in err && typeof (err as { retryAfter: unknown }).retryAfter === 'number') {
      return (err as { retryAfter: number }).retryAfter;
    }
    // Fallback: some errors expose retry_after in seconds (raw Discord API)
    if ('retry_after' in err && typeof (err as { retry_after: unknown }).retry_after === 'number') {
      return (err as { retry_after: number }).retry_after * 1000;
    }
  }
  return null;
}
