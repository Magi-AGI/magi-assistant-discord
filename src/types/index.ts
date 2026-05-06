export type { SttConfig } from '@magi/common';
import type { SttConfig } from '@magi/common';

export interface FoundryBridgeConfig {
  /** Base URL of the foundry-bridge MCP StreamableHTTP endpoint (e.g. http://127.0.0.1:3002/mcp). */
  mcpUrl: string;
  /**
   * Bearer token for the foundry-bridge MCP server. Sourced from env at config-load
   * time (default env var: FOUNDRY_BRIDGE_TOKEN; override per-guild via `tokenEnv`
   * in config.json). Never read from config.json directly to keep secrets out of
   * the file.
   */
  mcpToken: string;
  /** When false, this guild's lifecycle never touches Foundry recording. */
  enabled: boolean;
}

export interface GuildConfig {
  textChannels: string[];
  gmRoleId: string;
  timezone: string;
  /** When set, /session start/stop will drive Foundry video recording for this guild. */
  foundryBridge?: FoundryBridgeConfig;
}

export interface DataRetentionConfig {
  sessionRetentionDays: number;
  autoDeleteAudioFiles: boolean;
  enablePurgeCommand: boolean;
}

export interface AppConfig {
  discordToken: string;
  discordClientId: string;
  dataDir: string;
  dbPath: string;
  diskWarningThresholdMB: number;
  eventLoopLagThresholdMs: number;
  maxBurstDurationMinutes: number;
  guilds: Record<string, GuildConfig>;
  stt: SttConfig;
  dataRetention: DataRetentionConfig;
  mcpAuthToken: string;
  mcpSocketPath: string;
}
