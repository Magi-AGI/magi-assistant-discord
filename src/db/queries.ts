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
  stt_status: string | null;
  stt_mode: string | null;
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

/** Get all audio tracks for a user across all sessions in a guild. */
export function getUserAudioTracks(guildId: string, userId: string): AudioTrackRow[] {
  return getDb()
    .prepare(
      `SELECT at.* FROM audio_tracks at
       JOIN sessions s ON at.session_id = s.id
       WHERE s.guild_id = ? AND at.user_id = ?`
    )
    .all(guildId, userId) as AudioTrackRow[];
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

// --- Transcript segment queries ---

export interface TranscriptSegmentRow {
  id: number;
  session_id: string;
  track_id: number;
  burst_id: number | null;
  user_id: string;
  display_name: string | null;
  speaker_label: string | null;
  segment_start: string;
  segment_end: string | null;
  transcript: string;
  confidence: number | null;
  language: string;
  is_final: number;
  stt_result_id: string | null;
  stream_sequence: number;
  stt_engine: string;
  stt_model: string | null;
  created_at: string;
  updated_at: string | null;
}

/**
 * Insert a transcript segment, using UPSERT when stt_result_id is present.
 * This atomically handles the interim→final update race condition:
 * if a final arrives for the same (session_id, user_id, stream_sequence, stt_result_id)
 * composite key, it overwrites the interim in a single statement.
 */
export function insertTranscriptSegment(segment: {
  sessionId: string;
  trackId: number;
  burstId: number | null;
  userId: string;
  displayName: string | null;
  speakerLabel: string | null;
  segmentStart: string;
  segmentEnd: string | null;
  transcript: string;
  confidence: number | null;
  language: string;
  isFinal: boolean;
  sttResultId: string | null;
  streamSequence: number;
  sttEngine: string;
  sttModel: string | null;
}): number {
  const now = new Date().toISOString();
  const db = getDb();

  if (segment.sttResultId !== null) {
    // UPSERT: atomically insert or update by composite key on partial unique index
    const row = db
      .prepare(
        `INSERT INTO transcript_segments
         (session_id, track_id, burst_id, user_id, display_name, speaker_label,
          segment_start, segment_end, transcript, confidence, language, is_final,
          stt_result_id, stream_sequence, stt_engine, stt_model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, track_id, user_id, stream_sequence, stt_result_id)
           WHERE stt_result_id IS NOT NULL
         DO UPDATE SET
           transcript = CASE WHEN excluded.is_final >= is_final THEN excluded.transcript ELSE transcript END,
           confidence = CASE WHEN excluded.is_final >= is_final THEN excluded.confidence ELSE confidence END,
           segment_end = CASE WHEN excluded.is_final >= is_final THEN excluded.segment_end ELSE segment_end END,
           is_final = MAX(is_final, excluded.is_final),
           burst_id = COALESCE(excluded.burst_id, burst_id),
           display_name = COALESCE(excluded.display_name, display_name),
           speaker_label = COALESCE(excluded.speaker_label, speaker_label),
           updated_at = ?
         RETURNING id`
      )
      .get(
        segment.sessionId, segment.trackId, segment.burstId,
        segment.userId, segment.displayName, segment.speakerLabel,
        segment.segmentStart, segment.segmentEnd,
        segment.transcript, segment.confidence, segment.language,
        segment.isFinal ? 1 : 0, segment.sttResultId,
        segment.streamSequence, segment.sttEngine, segment.sttModel, now,
        now // for updated_at in DO UPDATE
      ) as { id: number };
    return row.id;
  }

  // Plain INSERT for rows without stt_result_id (no conflict possible on partial index)
  const result = db
    .prepare(
      `INSERT INTO transcript_segments
       (session_id, track_id, burst_id, user_id, display_name, speaker_label,
        segment_start, segment_end, transcript, confidence, language, is_final,
        stt_result_id, stream_sequence, stt_engine, stt_model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      segment.sessionId, segment.trackId, segment.burstId,
      segment.userId, segment.displayName, segment.speakerLabel,
      segment.segmentStart, segment.segmentEnd,
      segment.transcript, segment.confidence, segment.language,
      segment.isFinal ? 1 : 0, segment.sttResultId,
      segment.streamSequence, segment.sttEngine, segment.sttModel, now
    );
  return Number(result.lastInsertRowid);
}


export function getSessionTranscripts(sessionId: string): TranscriptSegmentRow[] {
  return getDb()
    .prepare('SELECT * FROM transcript_segments WHERE session_id = ? ORDER BY segment_start')
    .all(sessionId) as TranscriptSegmentRow[];
}

/**
 * Incremental fetch: returns rows with id > afterId OR rows updated since updatedSince.
 * The updatedSince parameter catches in-place interim→final updates that don't create new rows.
 */
export function getSessionTranscriptsAfterId(sessionId: string, afterId: number, limit: number = 100, updatedSince?: string): TranscriptSegmentRow[] {
  if (updatedSince) {
    return getDb()
      .prepare(
        `SELECT * FROM transcript_segments
         WHERE session_id = ? AND (id > ? OR (updated_at IS NOT NULL AND updated_at > ?))
         ORDER BY id LIMIT ?`
      )
      .all(sessionId, afterId, updatedSince, limit) as TranscriptSegmentRow[];
  }
  return getDb()
    .prepare('SELECT * FROM transcript_segments WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?')
    .all(sessionId, afterId, limit) as TranscriptSegmentRow[];
}

export function getTranscriptsForBurst(burstId: number): TranscriptSegmentRow[] {
  return getDb()
    .prepare('SELECT * FROM transcript_segments WHERE burst_id = ? ORDER BY segment_start')
    .all(burstId) as TranscriptSegmentRow[];
}

export function searchTranscripts(sessionId: string, query: string, limit: number = 100): TranscriptSegmentRow[] {
  return getDb()
    .prepare('SELECT * FROM transcript_segments WHERE session_id = ? AND transcript LIKE ? ORDER BY segment_start LIMIT ?')
    .all(sessionId, `%${query}%`, limit) as TranscriptSegmentRow[];
}

export function getParticipantSpeech(sessionId: string, userId: string): TranscriptSegmentRow[] {
  return getDb()
    .prepare('SELECT * FROM transcript_segments WHERE session_id = ? AND user_id = ? ORDER BY segment_start')
    .all(sessionId, userId) as TranscriptSegmentRow[];
}

/**
 * Find the burst whose time range contains the given timestamp.
 * Uses julianday() for numeric comparison (format-independent — works
 * with both ISO 8601 "T" and space-separated datetime strings) and a
 * 1-second fuzzy window on each boundary to absorb clock jitter between
 * Discord audio timestamps and Google Cloud STT timestamps.
 */
export function findBurstForTimestamp(trackId: number, timestamp: string): SpeechBurstRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM audio_speech_bursts
       WHERE track_id = ?
         AND julianday(burst_start) <= julianday(?, '+1 second')
         AND (burst_end IS NULL OR julianday(burst_end) >= julianday(?, '-1 second'))
       LIMIT 1`
    )
    .get(trackId, timestamp, timestamp) as SpeechBurstRow | undefined;
}

// --- Speaker mapping queries ---

export interface SpeakerMappingRow {
  id: number;
  session_id: string;
  speaker_label: string;
  player_name: string;
  mapped_at: string;
  mapped_by: string;
}

export function insertSpeakerMapping(mapping: {
  sessionId: string;
  speakerLabel: string;
  playerName: string;
  mappedBy: string;
}): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO speaker_mappings (session_id, speaker_label, player_name, mapped_at, mapped_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, speaker_label) DO UPDATE SET player_name = ?, mapped_at = ?, mapped_by = ?`
    )
    .run(
      mapping.sessionId, mapping.speakerLabel, mapping.playerName, now, mapping.mappedBy,
      mapping.playerName, now, mapping.mappedBy
    );
}

export function getSpeakerMappings(sessionId: string): SpeakerMappingRow[] {
  return getDb()
    .prepare('SELECT * FROM speaker_mappings WHERE session_id = ?')
    .all(sessionId) as SpeakerMappingRow[];
}

export function updateDisplayNameBySpeakerLabel(sessionId: string, speakerLabel: string, displayName: string): number {
  const result = getDb()
    .prepare(
      'UPDATE transcript_segments SET display_name = ?, updated_at = ? WHERE session_id = ? AND speaker_label = ?'
    )
    .run(displayName, new Date().toISOString(), sessionId, speakerLabel);
  return result.changes;
}

// --- STT usage queries ---

export interface SttUsageRow {
  id: number;
  session_id: string;
  engine: string;
  audio_duration_ms: number;
  segment_count: number;
  estimated_cost_usd: number | null;
  created_at: string;
}

export function insertSttUsage(usage: {
  sessionId: string;
  engine: string;
  audioDurationMs: number;
  segmentCount: number;
  estimatedCostUsd: number | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO stt_usage (session_id, engine, audio_duration_ms, segment_count, estimated_cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(usage.sessionId, usage.engine, usage.audioDurationMs, usage.segmentCount, usage.estimatedCostUsd, new Date().toISOString());
}

export function getSessionSttUsage(sessionId: string): SttUsageRow[] {
  return getDb()
    .prepare('SELECT * FROM stt_usage WHERE session_id = ?')
    .all(sessionId) as SttUsageRow[];
}

// --- Audio track STT status queries ---

export function updateTrackSttStatus(trackId: number, status: string): void {
  getDb()
    .prepare('UPDATE audio_tracks SET stt_status = ? WHERE id = ?')
    .run(status, trackId);
}

export function updateTrackSttMode(trackId: number, mode: string): void {
  getDb()
    .prepare('UPDATE audio_tracks SET stt_mode = ? WHERE id = ?')
    .run(mode, trackId);
}

// --- Session management queries (for MCP + retention) ---

export function getRecentSessions(limit: number = 20): SessionRow[] {
  return getDb()
    .prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?')
    .all(limit) as SessionRow[];
}

export function getSessionsOlderThan(cutoffDate: string): SessionRow[] {
  return getDb()
    .prepare("SELECT * FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ? AND status != 'active'")
    .all(cutoffDate) as SessionRow[];
}

export function deleteSessionCascade(sessionId: string): void {
  const db = getDb();
  const del = db.transaction(() => {
    db.prepare('DELETE FROM transcript_segments WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM speaker_mappings WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM stt_usage WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM text_events WHERE session_id = ?').run(sessionId);
    // Delete speech bursts for this session's tracks
    db.prepare(
      'DELETE FROM audio_speech_bursts WHERE track_id IN (SELECT id FROM audio_tracks WHERE session_id = ?)'
    ).run(sessionId);
    db.prepare('DELETE FROM audio_tracks WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM participants WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  });
  del();
}

export function deleteUserDataInGuild(guildId: string, userId: string): { sessionsAffected: number; segmentsDeleted: number; tracksDeleted: number } {
  const db = getDb();
  let sessionsAffected = 0;
  let segmentsDeleted = 0;
  let tracksDeleted = 0;

  const del = db.transaction(() => {
    // Find all sessions in this guild
    const sessions = db.prepare('SELECT id FROM sessions WHERE guild_id = ?').all(guildId) as { id: string }[];
    const sessionIds = sessions.map((s) => s.id);

    for (const sid of sessionIds) {
      let hadData = false;

      // Delete transcript segments for this user in this session
      const segResult = db.prepare('DELETE FROM transcript_segments WHERE session_id = ? AND user_id = ?').run(sid, userId);
      segmentsDeleted += segResult.changes;
      if (segResult.changes > 0) hadData = true;

      // Delete speech bursts for this user's tracks
      const trackIds = db.prepare('SELECT id FROM audio_tracks WHERE session_id = ? AND user_id = ?')
        .all(sid, userId) as { id: number }[];
      for (const t of trackIds) {
        db.prepare('DELETE FROM audio_speech_bursts WHERE track_id = ?').run(t.id);
      }
      const trackResult = db.prepare('DELETE FROM audio_tracks WHERE session_id = ? AND user_id = ?').run(sid, userId);
      tracksDeleted += trackResult.changes;
      if (trackResult.changes > 0) hadData = true;

      // Delete participant records
      const partResult = db.prepare('DELETE FROM participants WHERE session_id = ? AND user_id = ?').run(sid, userId);
      if (partResult.changes > 0) hadData = true;

      // Delete text events
      const textResult = db.prepare('DELETE FROM text_events WHERE session_id = ? AND user_id = ?').run(sid, userId);
      if (textResult.changes > 0) hadData = true;

      if (hadData) sessionsAffected++;
    }

    // Delete consent record
    db.prepare('DELETE FROM consent WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
  });
  del();

  return { sessionsAffected, segmentsDeleted, tracksDeleted };
}
