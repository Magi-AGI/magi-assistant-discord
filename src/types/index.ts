export interface GuildConfig {
  textChannels: string[];
  gmRoleId: string;
  timezone: string;
}

export interface SttConfig {
  enabled: boolean;
  engine: 'google-cloud-stt' | 'whisper' | 'gemini';
  googleCloud: {
    projectId: string;
    keyFile: string;
    model: string;
    languageCode: string;
    enableAutomaticPunctuation: boolean;
    sampleRateHertz: number;
    streamRotationMinutes: number;
    streamOverlapSeconds: number;
    /** Phrase hints for speech recognition — character names, place names, game terms, etc. */
    phraseHints: string[];
  };
  diarization: { minSpeakers: number; maxSpeakers: number };
  silenceTimeoutSeconds: number;
  connectionCooldownSeconds: number;
  whisper: { modelPath: string; language: string };
  costWarningPerSessionUsd: number;
  maxConcurrentStreams: number;
  interimThrottlePerSecond: number;
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
