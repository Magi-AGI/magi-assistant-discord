import {
  type VoiceConnection,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice';
import { logger } from '../logger.js';

const MAX_RECONNECT_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1_000; // 1s, 2s, 4s

/**
 * Register a disconnect handler with automatic reconnection and exponential backoff.
 *
 * When the voice connection enters Disconnected:
 * 1. Waits 5s for Discord.js automatic reconnection (server move, etc.)
 * 2. If that fails, tries manual rejoin() with exponential backoff (3 attempts)
 * 3. If all attempts fail, calls onFailed to end the session cleanly
 */
export function registerReconnectHandler(
  connection: VoiceConnection,
  sessionId: string,
  onFailed: () => Promise<void>
): void {
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    logger.warn(`Session ${sessionId}: voice connection disconnected`);

    // If the connection was already destroyed (e.g., session stop), nothing to do
    if (connection.state.status === VoiceConnectionStatus.Destroyed) return;

    // First, wait for Discord.js automatic reconnection (e.g., voice server move)
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      // Automatic recovery started -- wait for Ready
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      logger.info(`Session ${sessionId}: voice connection automatically reconnected`);
      return;
    } catch {
      // Automatic reconnection didn't work -- try manual
    }

    // Manual reconnection with exponential backoff
    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
      // State can change asynchronously between awaits; cast to bypass TS narrowing
      if ((connection.state.status as string) === VoiceConnectionStatus.Destroyed) {
        logger.info(`Session ${sessionId}: connection destroyed during reconnect -- aborting`);
        return;
      }

      const backoffMs = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
      logger.warn(
        `Session ${sessionId}: manual reconnect attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS} (backoff: ${backoffMs}ms)`
      );

      await sleep(backoffMs);

      // Re-check after sleeping -- session may have been stopped by the user
      if ((connection.state.status as string) === VoiceConnectionStatus.Destroyed) {
        logger.info(`Session ${sessionId}: connection destroyed during backoff -- aborting`);
        return;
      }

      try {
        connection.rejoin();
        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
        logger.info(`Session ${sessionId}: voice reconnected on attempt ${attempt}`);
        return;
      } catch {
        logger.warn(`Session ${sessionId}: reconnect attempt ${attempt} failed`);
      }
    }

    // All attempts exhausted
    logger.error(
      `Session ${sessionId}: voice reconnection failed after ${MAX_RECONNECT_ATTEMPTS} attempts -- ending session`
    );
    await onFailed();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
