import { config as dotenvConfig } from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import type { AppConfig, GuildConfig, SttConfig, DataRetentionConfig } from './types/index.js';
import { registerSecret } from './logger.js';

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

  const stt = parseSttConfig((file.stt ?? {}) as Record<string, unknown>);
  const dataRetention = parseDataRetentionConfig((file.dataRetention ?? {}) as Record<string, unknown>);

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
    stt,
    dataRetention,
    mcpAuthToken: process.env.MCP_AUTH_TOKEN ?? '',
    mcpSocketPath: typeof file.mcpSocketPath === 'string' ? file.mcpSocketPath : '',
  };

  // Register secrets for log redaction
  if (_config.mcpAuthToken) registerSecret(_config.mcpAuthToken);

  return _config;
}

function parseSttConfig(raw: Record<string, unknown>): SttConfig {
  const gc = (raw.googleCloud ?? {}) as Record<string, unknown>;
  const diar = (raw.diarization ?? {}) as Record<string, unknown>;
  const wh = (raw.whisper ?? {}) as Record<string, unknown>;
  return {
    enabled: raw.enabled === true,
    engine: (['google-cloud-stt', 'whisper', 'gemini'].includes(raw.engine as string)
      ? raw.engine as SttConfig['engine']
      : 'google-cloud-stt'),
    googleCloud: {
      projectId: typeof gc.projectId === 'string' ? gc.projectId : '',
      keyFile: typeof gc.keyFile === 'string' ? gc.keyFile : '',
      model: typeof gc.model === 'string' ? gc.model : 'latest_long',
      languageCode: typeof gc.languageCode === 'string' ? gc.languageCode : 'en-US',
      enableAutomaticPunctuation: gc.enableAutomaticPunctuation !== false,
      sampleRateHertz: validatePositiveNumber(gc.sampleRateHertz, 'stt.googleCloud.sampleRateHertz', 16000),
      streamRotationMinutes: validatePositiveNumber(gc.streamRotationMinutes, 'stt.googleCloud.streamRotationMinutes', 4),
      streamOverlapSeconds: validatePositiveNumber(gc.streamOverlapSeconds, 'stt.googleCloud.streamOverlapSeconds', 5),
    },
    diarization: {
      minSpeakers: validatePositiveNumber(diar.minSpeakers, 'stt.diarization.minSpeakers', 2),
      maxSpeakers: validatePositiveNumber(diar.maxSpeakers, 'stt.diarization.maxSpeakers', 6),
    },
    silenceTimeoutSeconds: validatePositiveNumber(raw.silenceTimeoutSeconds, 'stt.silenceTimeoutSeconds', 5),
    connectionCooldownSeconds: validatePositiveNumber(raw.connectionCooldownSeconds, 'stt.connectionCooldownSeconds', 2),
    whisper: {
      modelPath: typeof wh.modelPath === 'string' ? wh.modelPath : '',
      language: typeof wh.language === 'string' ? wh.language : 'en',
    },
    costWarningPerSessionUsd: validatePositiveNumber(raw.costWarningPerSessionUsd, 'stt.costWarningPerSessionUsd', 5.0),
    maxConcurrentStreams: validatePositiveNumber(raw.maxConcurrentStreams, 'stt.maxConcurrentStreams', 8),
    interimThrottlePerSecond: validatePositiveNumber(raw.interimThrottlePerSecond, 'stt.interimThrottlePerSecond', 2),
  };
}

function parseDataRetentionConfig(raw: Record<string, unknown>): DataRetentionConfig {
  return {
    sessionRetentionDays: typeof raw.sessionRetentionDays === 'number' && raw.sessionRetentionDays > 0
      ? raw.sessionRetentionDays : 0,
    autoDeleteAudioFiles: raw.autoDeleteAudioFiles === true,
    enablePurgeCommand: raw.enablePurgeCommand === true,
  };
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
