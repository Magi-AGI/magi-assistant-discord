import { config as dotenvConfig } from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import type { AppConfig, GuildConfig } from './types/index.js';

dotenvConfig();

function loadConfigFile(): Record<string, unknown> {
  const configPath = path.resolve(process.cwd(), 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse config.json: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function validatePositiveNumber(value: unknown, name: string, fallback: number): number {
  if (typeof value === 'number' && value > 0) return value;
  if (value !== undefined && value !== null) {
    console.warn(`[WARN] config.json: ${name} should be a positive number, using default ${fallback}`);
  }
  return fallback;
}

function validateGuild(guildId: string, data: Record<string, unknown>): GuildConfig {
  const textChannels = data.textChannels;
  if (textChannels !== undefined && !Array.isArray(textChannels)) {
    throw new Error(
      `config.json: guilds.${guildId}.textChannels must be an array of channel ID strings`
    );
  }

  return {
    textChannels: Array.isArray(textChannels)
      ? textChannels.filter((ch): ch is string => typeof ch === 'string')
      : [],
    gmRoleId: typeof data.gmRoleId === 'string' ? data.gmRoleId : '',
    timezone: typeof data.timezone === 'string' ? data.timezone : 'UTC',
  };
}

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (_config) return _config;

  const file = loadConfigFile();

  const guilds: Record<string, GuildConfig> = {};
  const rawGuilds = (file.guilds ?? {}) as Record<string, Record<string, unknown>>;
  for (const [guildId, guildData] of Object.entries(rawGuilds)) {
    guilds[guildId] = validateGuild(guildId, guildData);
  }

  _config = {
    // Lazy: scripts like hydrate-audio only need dataDir/dbPath, not tokens
    discordToken: process.env.DISCORD_TOKEN ?? '',
    discordClientId: process.env.DISCORD_CLIENT_ID ?? '',
    dataDir: typeof file.dataDir === 'string' ? file.dataDir : './data/sessions',
    dbPath: typeof file.dbPath === 'string' ? file.dbPath : './data/bot.sqlite',
    diskWarningThresholdMB: validatePositiveNumber(file.diskWarningThresholdMB, 'diskWarningThresholdMB', 500),
    eventLoopLagThresholdMs: validatePositiveNumber(file.eventLoopLagThresholdMs, 'eventLoopLagThresholdMs', 100),
    maxBurstDurationMinutes: validatePositiveNumber(file.maxBurstDurationMinutes, 'maxBurstDurationMinutes', 10),
    guilds,
  };

  return _config;
}

/** Require DISCORD_TOKEN — call this only when the bot is connecting. */
export function requireDiscordToken(): string {
  const config = getConfig();
  if (!config.discordToken) {
    throw new Error(
      'Missing DISCORD_TOKEN environment variable (required for bot login)'
    );
  }
  return config.discordToken;
}

/** Require DISCORD_CLIENT_ID — call this only when command registration is needed. */
export function requireClientId(): string {
  const config = getConfig();
  if (!config.discordClientId) {
    throw new Error(
      'Missing DISCORD_CLIENT_ID environment variable (required for slash command registration)'
    );
  }
  return config.discordClientId;
}
