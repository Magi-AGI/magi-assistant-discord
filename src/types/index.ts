export interface GuildConfig {
  textChannels: string[];
  gmRoleId: string;
  timezone: string;
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
}
