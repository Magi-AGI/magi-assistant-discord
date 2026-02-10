import { config as dotenvConfig } from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import type { AppConfig, GuildConfig } from './types';

dotenvConfig();

function loadConfigFile(): Record<string, unknown> {
  const configPath = path.resolve(process.cwd(), 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(raw);
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (_config) return _config;

  const file = loadConfigFile();

  const guilds: Record<string, GuildConfig> = {};
  const rawGuilds = (file.guilds ?? {}) as Record<string, Record<string, unknown>>;
  for (const [guildId, guildData] of Object.entries(rawGuilds)) {
    guilds[guildId] = {
      textChannels: (guildData.textChannels as string[]) ?? [],
      gmRoleId: (guildData.gmRoleId as string) ?? '',
      timezone: (guildData.timezone as string) ?? 'UTC',
    };
  }

  _config = {
    discordToken: requireEnv('DISCORD_TOKEN'),
    discordClientId: requireEnv('DISCORD_CLIENT_ID'),
    dataDir: (file.dataDir as string) ?? './data/sessions',
    dbPath: (file.dbPath as string) ?? './data/bot.sqlite',
    diskWarningThresholdMB: (file.diskWarningThresholdMB as number) ?? 500,
    eventLoopLagThresholdMs: (file.eventLoopLagThresholdMs as number) ?? 100,
    maxBurstDurationMinutes: (file.maxBurstDurationMinutes as number) ?? 10,
    guilds,
  };

  return _config;
}
