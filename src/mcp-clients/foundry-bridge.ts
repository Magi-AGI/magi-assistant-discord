/**
 * MCP client for the magi-assistant-foundry sidecar.
 *
 * The Discord bot's session lifecycle calls notifyRecordingStart / notifyRecordingStop
 * when /session start and /session stop fire. Both helpers are fire-and-forget:
 * a Foundry sidecar that is unreachable, slow, or returns an error must never
 * block or fail a Discord session — the recording is a best-effort companion to
 * the audio capture, not a precondition.
 *
 * Connection model: one persistent client per guild (keyed by guildId) so each
 * guild can target a different sidecar deployment. We connect lazily on first
 * call and reuse the connection across sessions; on transport error we mark the
 * client closed and let the next call reconnect.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { logger } from '../logger.js';
import type { FoundryBridgeConfig } from '../types/index.js';

interface BridgeEntry {
  config: FoundryBridgeConfig;
  client: Client | null;
  transport: SSEClientTransport | null;
  /** In-flight connect promise, so concurrent callers share one attempt. */
  connecting: Promise<Client> | null;
}

const bridges = new Map<string, BridgeEntry>();

/** Tool-call timeout. Foundry sidecar does its own 5s correlation-id wait — leave headroom. */
const FOUNDRY_TOOL_TIMEOUT_MS = 8_000;

function getEntry(guildId: string, config: FoundryBridgeConfig): BridgeEntry {
  let entry = bridges.get(guildId);
  if (!entry) {
    entry = { config, client: null, transport: null, connecting: null };
    bridges.set(guildId, entry);
  } else {
    // If config changed (URL or token), reset so the next call reconnects with the new values.
    if (entry.config.mcpUrl !== config.mcpUrl || entry.config.mcpToken !== config.mcpToken) {
      void closeBridge(guildId, 'config changed');
      entry = { config, client: null, transport: null, connecting: null };
      bridges.set(guildId, entry);
    }
  }
  return entry;
}

async function connect(entry: BridgeEntry): Promise<Client> {
  if (entry.client) return entry.client;
  if (entry.connecting) return entry.connecting;

  entry.connecting = (async (): Promise<Client> => {
    const url = new URL(entry.config.mcpUrl);
    const headers = { Authorization: `Bearer ${entry.config.mcpToken}` };
    // EventSource doesn't expose a way to send custom headers in Node's
    // built-in implementation, so we fall back to the query-token mode the
    // foundry-bridge server accepts on GET /sse. POST /messages still gets
    // the Authorization header via requestInit.
    if (!url.searchParams.has('token')) {
      url.searchParams.set('token', entry.config.mcpToken);
    }

    const transport = new SSEClientTransport(url, {
      requestInit: { headers },
      eventSourceInit: {
        fetch: (input, init) => fetch(input as URL, { ...init, headers: { ...(init?.headers ?? {}), ...headers } }),
      },
    });

    const client = new Client(
      { name: 'magi-assistant-discord', version: '0.1.0' },
      { capabilities: {} }
    );

    transport.onclose = (): void => {
      logger.info(`Foundry bridge MCP transport closed (guild ${guildIdFor(entry)})`);
      entry.client = null;
      entry.transport = null;
    };
    transport.onerror = (err): void => {
      logger.warn(`Foundry bridge MCP transport error (guild ${guildIdFor(entry)}): ${err.message}`);
    };

    await client.connect(transport);
    entry.client = client;
    entry.transport = transport;
    logger.info(`Foundry bridge MCP connected (guild ${guildIdFor(entry)} → ${entry.config.mcpUrl})`);
    return client;
  })();

  try {
    return await entry.connecting;
  } finally {
    entry.connecting = null;
  }
}

/** Reverse-lookup a guildId by entry, for logging. */
function guildIdFor(entry: BridgeEntry): string {
  for (const [gid, e] of bridges) {
    if (e === entry) return gid;
  }
  return '?';
}

async function callRecording(
  guildId: string,
  config: FoundryBridgeConfig,
  toolName: 'recording_start' | 'recording_stop',
  reason: string
): Promise<void> {
  if (!config.enabled) return;
  const entry = getEntry(guildId, config);
  let client: Client;
  try {
    client = await connect(entry);
  } catch (err) {
    logger.warn(`Foundry bridge: connect failed for guild ${guildId} — ${describe(err)}`);
    return;
  }

  try {
    const result = await client.callTool(
      { name: toolName, arguments: { reason } },
      undefined,
      { timeout: FOUNDRY_TOOL_TIMEOUT_MS }
    );
    if ('isError' in result && result.isError) {
      const text = extractText(result);
      logger.warn(`Foundry bridge: ${toolName} returned error for guild ${guildId}: ${text}`);
      return;
    }
    logger.info(`Foundry bridge: ${toolName} ok for guild ${guildId} (${reason})`);
  } catch (err) {
    logger.warn(`Foundry bridge: ${toolName} threw for guild ${guildId} — ${describe(err)}`);
    // Drop the client on hard failure so the next call reconnects.
    await closeBridge(guildId, 'tool call failed');
  }
}

function extractText(result: unknown): string {
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  if (!Array.isArray(r.content)) return '(no content)';
  return r.content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join(' ') || '(empty)';
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Notify the foundry sidecar that a recording session has started.
 * Fire-and-forget: errors are logged, never thrown.
 */
export async function notifyRecordingStart(
  guildId: string,
  config: FoundryBridgeConfig | undefined,
  reason: string
): Promise<void> {
  if (!config) return;
  await callRecording(guildId, config, 'recording_start', reason);
}

/**
 * Notify the foundry sidecar that a recording session has ended.
 * Fire-and-forget: errors are logged, never thrown.
 */
export async function notifyRecordingStop(
  guildId: string,
  config: FoundryBridgeConfig | undefined,
  reason: string
): Promise<void> {
  if (!config) return;
  await callRecording(guildId, config, 'recording_stop', reason);
}

/** Close the per-guild bridge connection. Safe to call multiple times. */
export async function closeBridge(guildId: string, reason: string): Promise<void> {
  const entry = bridges.get(guildId);
  if (!entry) return;
  bridges.delete(guildId);
  if (entry.client) {
    try {
      await entry.client.close();
    } catch {
      // best effort
    }
  }
  if (entry.transport) {
    try {
      await entry.transport.close();
    } catch {
      // best effort
    }
  }
  logger.info(`Foundry bridge closed for guild ${guildId} (${reason})`);
}

/** Tear down all bridge clients. Called from graceful shutdown. */
export async function shutdownAllBridges(): Promise<void> {
  const guildIds = [...bridges.keys()];
  await Promise.allSettled(guildIds.map((gid) => closeBridge(gid, 'shutdown')));
}
