export type { SttConfig } from '@magi/common';
import type { SttConfig } from '@magi/common';

export interface GuildConfig {
  textChannels: string[];
  gmRoleId: string;
  timezone: string;
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
