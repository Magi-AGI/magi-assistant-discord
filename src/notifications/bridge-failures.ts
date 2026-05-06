/**
 * Surfaces foundry-bridge call failures as Discord channel messages.
 *
 * The bridge layer (mcp-clients/foundry-bridge.ts) emits BridgeFailure events
 * when fire-and-forget calls to the Foundry sidecar fail. This notifier
 * subscribes, debounces by (guild, cause, op), and posts to the active
 * session's status channel. The bridge call itself remains fire-and-forget;
 * notifications run out-of-band via the event handler.
 */

import type { Client, TextChannel } from 'discord.js';
import { onBridgeFailure, type BridgeFailure } from '../mcp-clients/foundry-bridge.js';
import { getActiveSessionForGuild } from '../session-manager.js';
import { withRateLimitRetry } from '../utils/rate-limit.js';
import { logger } from '../logger.js';

/** Minimum interval between messages for the same (guild, cause, op) tuple. */
const DEBOUNCE_WINDOW_MS = 60_000;

const lastEmitted = new Map<string, number>();

function describeCause(cause: BridgeFailure['cause']): string {
  switch (cause) {
    case 'unreachable': return 'Foundry bridge unreachable';
    case 'tool-error': return 'Foundry rejected the request';
    case 'tool-threw': return 'Foundry call failed';
  }
}

function describeOp(op: BridgeFailure['op']): string {
  return op === 'recording_start' ? 'start recording' : 'stop recording';
}

/** Subscribe to bridge failures and post them to the active session's channel.
 *  Returns an unsubscribe function suitable for shutdown wiring. */
export function startBridgeFailureNotifier(client: Client): () => void {
  return onBridgeFailure((event) => {
    void handle(client, event).catch((err) => {
      logger.warn('Bridge failure notifier error:', err);
    });
  });
}

async function handle(client: Client, event: BridgeFailure): Promise<void> {
  const key = `${event.guildId}:${event.cause}:${event.op}`;
  const now = Date.now();
  const last = lastEmitted.get(key) ?? 0;
  if (now - last < DEBOUNCE_WINDOW_MS) return;
  lastEmitted.set(key, now);

  const session = getActiveSessionForGuild(event.guildId);
  const channelId = session?.statusChannelId;
  if (!channelId) {
    logger.warn(
      `Bridge failure for guild ${event.guildId} (${event.op}/${event.cause}) — no status channel known: ${event.message}`
    );
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !('send' in channel)) {
    logger.warn(`Bridge failure for guild ${event.guildId}: channel ${channelId} not sendable`);
    return;
  }

  const summary = `Could not ${describeOp(event.op)}: ${describeCause(event.cause)}`;
  const detail = event.message ? ` — ${event.message}` : '';
  const content = `Foundry: ${summary}${detail}`;

  try {
    await withRateLimitRetry(() => (channel as TextChannel).send({ content }));
  } catch (err) {
    logger.warn(`Bridge failure notify send failed for guild ${event.guildId}:`, err);
  }
}
