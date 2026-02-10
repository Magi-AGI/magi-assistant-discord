import { getDb } from './index.js';

// --- Session queries ---

export interface SessionRow {
  id: string;
  guild_id: string;
  voice_channel_id: string;
  text_channel_ids: string | null;
  timezone: string;
  started_at: string;
  ended_at: string | null;
  status: string;
  metadata: string | null;
}

export function insertSession(session: {
  id: string;
  guildId: string;
  voiceChannelId: string;
  textChannelIds: string[];
  timezone: string;
  startedAt: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, guild_id, voice_channel_id, text_channel_ids, timezone, started_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`
    )
    .run(
      session.id,
      session.guildId,
      session.voiceChannelId,
      JSON.stringify(session.textChannelIds),
      session.timezone,
      session.startedAt
    );
}

export function getActiveSession(guildId: string): SessionRow | undefined {
  return getDb()
    .prepare("SELECT * FROM sessions WHERE guild_id = ? AND status = 'active'")
    .get(guildId) as SessionRow | undefined;
}

export function endSession(sessionId: string, endedAt: string, status: 'stopped' | 'error' = 'stopped'): void {
  getDb()
    .prepare('UPDATE sessions SET ended_at = ?, status = ? WHERE id = ?')
    .run(endedAt, status, sessionId);
}

export function getSession(sessionId: string): SessionRow | undefined {
  return getDb()
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(sessionId) as SessionRow | undefined;
}

// --- Participant queries ---

export interface ParticipantRow {
  id: number;
  session_id: string;
  user_id: string;
  display_name: string;
  joined_at: string;
  left_at: string | null;
}

export function insertParticipant(participant: {
  sessionId: string;
  userId: string;
  displayName: string;
  joinedAt: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO participants (session_id, user_id, display_name, joined_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(participant.sessionId, participant.userId, participant.displayName, participant.joinedAt);
}

export function markParticipantLeft(sessionId: string, userId: string, leftAt: string): void {
  getDb()
    .prepare(
      `UPDATE participants SET left_at = ?
       WHERE session_id = ? AND user_id = ? AND left_at IS NULL`
    )
    .run(leftAt, sessionId, userId);
}

export function getSessionParticipants(sessionId: string): ParticipantRow[] {
  return getDb()
    .prepare('SELECT * FROM participants WHERE session_id = ?')
    .all(sessionId) as ParticipantRow[];
}

// --- Audio track queries ---

export interface AudioTrackRow {
  id: number;
  session_id: string;
  user_id: string;
  file_path: string;
  started_at: string;
  first_packet_at: string | null;
  ended_at: string | null;
  codec: string;
  container: string;
}

export function insertAudioTrack(track: {
  sessionId: string;
  userId: string;
  filePath: string;
  startedAt: string;
}): number {
  const result = getDb()
    .prepare(
      `INSERT INTO audio_tracks (session_id, user_id, file_path, started_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(track.sessionId, track.userId, track.filePath, track.startedAt);
  return Number(result.lastInsertRowid);
}

export function updateAudioTrackFilePath(trackId: number, filePath: string): void {
  getDb()
    .prepare('UPDATE audio_tracks SET file_path = ? WHERE id = ?')
    .run(filePath, trackId);
}

export function setFirstPacketAt(trackId: number, firstPacketAt: string): void {
  getDb()
    .prepare('UPDATE audio_tracks SET first_packet_at = ? WHERE id = ?')
    .run(firstPacketAt, trackId);
}

export function endAudioTrack(trackId: number, endedAt: string): void {
  getDb()
    .prepare('UPDATE audio_tracks SET ended_at = ? WHERE id = ?')
    .run(endedAt, trackId);
}

export function getSessionTracks(sessionId: string): AudioTrackRow[] {
  return getDb()
    .prepare('SELECT * FROM audio_tracks WHERE session_id = ?')
    .all(sessionId) as AudioTrackRow[];
}

export function getTrackCountForUser(sessionId: string, userId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) as count FROM audio_tracks WHERE session_id = ? AND user_id = ?')
    .get(sessionId, userId) as { count: number };
  return row.count;
}

// --- Speech burst queries ---

export interface SpeechBurstRow {
  id: number;
  track_id: number;
  burst_start: string;
  burst_end: string | null;
  start_frame_offset: number;
  end_frame_offset: number | null;
}

export function insertBurst(burst: {
  trackId: number;
  burstStart: string;
  startFrameOffset: number;
}): number {
  const result = getDb()
    .prepare(
      `INSERT INTO audio_speech_bursts (track_id, burst_start, start_frame_offset)
       VALUES (?, ?, ?)`
    )
    .run(burst.trackId, burst.burstStart, burst.startFrameOffset);
  return Number(result.lastInsertRowid);
}

export function closeBurst(burstId: number, burstEnd: string, endFrameOffset: number): void {
  getDb()
    .prepare(
      'UPDATE audio_speech_bursts SET burst_end = ?, end_frame_offset = ? WHERE id = ?'
    )
    .run(burstEnd, endFrameOffset, burstId);
}

export function getOpenBurst(trackId: number): SpeechBurstRow | undefined {
  return getDb()
    .prepare('SELECT * FROM audio_speech_bursts WHERE track_id = ? AND burst_end IS NULL')
    .get(trackId) as SpeechBurstRow | undefined;
}

export function getTrackBursts(trackId: number): SpeechBurstRow[] {
  return getDb()
    .prepare('SELECT * FROM audio_speech_bursts WHERE track_id = ? ORDER BY burst_start')
    .all(trackId) as SpeechBurstRow[];
}

// --- Text event queries ---

export interface TextEventRow {
  id: number;
  session_id: string;
  message_id: string;
  user_id: string | null;
  channel_id: string;
  message_timestamp: string | null;
  event_received_at: string;
  content: string | null;
  event_type: string;
}

export function insertTextEvent(event: {
  sessionId: string;
  messageId: string;
  userId: string | null;
  channelId: string;
  messageTimestamp: string | null;
  eventReceivedAt: string;
  content: string | null;
  eventType: 'create' | 'edit' | 'delete';
}): void {
  getDb()
    .prepare(
      `INSERT INTO text_events (session_id, message_id, user_id, channel_id, message_timestamp, event_received_at, content, event_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      event.sessionId,
      event.messageId,
      event.userId,
      event.channelId,
      event.messageTimestamp,
      event.eventReceivedAt,
      event.content,
      event.eventType
    );
}

export function getSessionTextEvents(sessionId: string): TextEventRow[] {
  return getDb()
    .prepare('SELECT * FROM text_events WHERE session_id = ? ORDER BY event_received_at')
    .all(sessionId) as TextEventRow[];
}

// --- Consent queries ---

export interface ConsentRow {
  guild_id: string;
  user_id: string;
  consented: number;
  updated_at: string;
}

export function getConsent(guildId: string, userId: string): ConsentRow | undefined {
  return getDb()
    .prepare('SELECT * FROM consent WHERE guild_id = ? AND user_id = ?')
    .get(guildId, userId) as ConsentRow | undefined;
}

export function upsertConsent(guildId: string, userId: string, consented: boolean): void {
  const now = new Date().toISOString();
  const value = consented ? 1 : 0;
  getDb()
    .prepare(
      `INSERT INTO consent (guild_id, user_id, consented, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id) DO UPDATE SET consented = ?, updated_at = ?`
    )
    .run(guildId, userId, value, now, value, now);
}

// --- Guild settings queries ---

export interface GuildSettingsRow {
  guild_id: string;
  consent_required: number;
  timezone: string;
  text_channels: string | null;
}

export function getGuildSettings(guildId: string): GuildSettingsRow | undefined {
  return getDb()
    .prepare('SELECT * FROM guild_settings WHERE guild_id = ?')
    .get(guildId) as GuildSettingsRow | undefined;
}

export function upsertGuildSettings(
  guildId: string,
  updates: { consentRequired?: boolean; timezone?: string; textChannels?: string[] }
): void {
  const existing = getGuildSettings(guildId);
  if (existing) {
    if (updates.consentRequired !== undefined) {
      getDb()
        .prepare('UPDATE guild_settings SET consent_required = ? WHERE guild_id = ?')
        .run(updates.consentRequired ? 1 : 0, guildId);
    }
    if (updates.timezone !== undefined) {
      getDb()
        .prepare('UPDATE guild_settings SET timezone = ? WHERE guild_id = ?')
        .run(updates.timezone, guildId);
    }
    if (updates.textChannels !== undefined) {
      getDb()
        .prepare('UPDATE guild_settings SET text_channels = ? WHERE guild_id = ?')
        .run(JSON.stringify(updates.textChannels), guildId);
    }
  } else {
    getDb()
      .prepare(
        `INSERT INTO guild_settings (guild_id, consent_required, timezone, text_channels)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        guildId,
        updates.consentRequired ? 1 : 0,
        updates.timezone ?? 'UTC',
        updates.textChannels ? JSON.stringify(updates.textChannels) : null
      );
  }
}

export function isConsentRequired(guildId: string): boolean {
  const settings = getGuildSettings(guildId);
  return settings ? settings.consent_required === 1 : false;
}
