import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getActiveSession as getActiveSessionDb,
  getSession,
  getSessionParticipants,
  getSessionTracks,
  getSessionTranscripts,
  getSessionTranscriptsAfterId,
  getSessionTextEvents,
  getRecentSessions,
} from '../db/queries.js';
import { getActiveSessionForGuild, getAllActiveSessions } from '../session-manager.js';
import type { LiveTranscriptManager } from './live-subscriptions.js';

export function registerResources(server: McpServer): void {
  // session://active — active session metadata
  server.resource(
    'active-session',
    'session://active',
    { description: 'Currently active recording session (if any)' },
    async () => {
      const sessions = getAllActiveSessions();
      if (sessions.length === 0) {
        return { contents: [{ uri: 'session://active', text: JSON.stringify({ active: false, sessions: [] }) }] };
      }

      const sessionData = sessions.map((session) => {
        const participants = getSessionParticipants(session.id);
        const tracks = getSessionTracks(session.id);
        return {
          id: session.id,
          guildId: session.guildId,
          voiceChannelId: session.voiceChannelId,
          startedAt: session.startedAt.toISOString(),
          diarized: session.diarized,
          participants: participants.map((p) => ({
            userId: p.user_id,
            displayName: p.display_name,
            joinedAt: p.joined_at,
            leftAt: p.left_at,
          })),
          trackCount: tracks.length,
        };
      });

      return {
        contents: [{
          uri: 'session://active',
          text: JSON.stringify({
            active: true,
            sessions: sessionData,
          }),
        }],
      };
    }
  );

  // session://list — recent sessions
  server.resource(
    'session-list',
    'session://list',
    { description: 'Recent recording sessions' },
    async (_uri, params) => {
      const limit = 20;
      const sessions = getRecentSessions(limit);

      return {
        contents: [{
          uri: 'session://list',
          text: JSON.stringify(
            sessions.map((s) => ({
              id: s.id,
              guildId: s.guild_id,
              startedAt: s.started_at,
              endedAt: s.ended_at,
              status: s.status,
            }))
          ),
        }],
      };
    }
  );

  // session://{id} — session details
  server.resource(
    'session-detail',
    'session://{id}',
    { description: 'Session details including participants and tracks' },
    async (uri) => {
      const sessionId = extractSessionId(uri.href);
      const session = getSession(sessionId);
      if (!session) {
        return { contents: [{ uri: uri.href, text: JSON.stringify({ error: 'Session not found' }) }] };
      }

      const participants = getSessionParticipants(sessionId);
      const tracks = getSessionTracks(sessionId);

      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify({
            id: session.id,
            guildId: session.guild_id,
            voiceChannelId: session.voice_channel_id,
            textChannelIds: session.text_channel_ids ? JSON.parse(session.text_channel_ids) : [],
            timezone: session.timezone,
            startedAt: session.started_at,
            endedAt: session.ended_at,
            status: session.status,
            participants: participants.map((p) => ({
              userId: p.user_id,
              displayName: p.display_name,
              joinedAt: p.joined_at,
              leftAt: p.left_at,
            })),
            tracks: tracks.map((t) => ({
              id: t.id,
              userId: t.user_id,
              filePath: t.file_path,
              startedAt: t.started_at,
              endedAt: t.ended_at,
              sttStatus: t.stt_status,
              sttMode: t.stt_mode,
            })),
          }),
        }],
      };
    }
  );

  // session://{id}/transcript — all transcript segments
  server.resource(
    'session-transcript',
    'session://{id}/transcript',
    { description: 'Transcript segments (supports ?after_id= and ?updated_since= for incremental fetch)' },
    async (uri) => {
      const sessionId = extractSessionId(uri.href);
      // Check for after_id and updated_since in query params
      const urlObj = new URL(uri.href, 'session://');
      const afterIdStr = urlObj.searchParams.get('after_id');
      const afterId = afterIdStr ? parseInt(afterIdStr, 10) : 0;
      const updatedSince = urlObj.searchParams.get('updated_since') ?? undefined;
      const limitStr = urlObj.searchParams.get('limit');
      const limit = limitStr ? Math.max(1, Math.min(parseInt(limitStr, 10) || 1000, 1000)) : undefined;

      let segments: ReturnType<typeof getSessionTranscripts>;
      if (afterId > 0) {
        segments = getSessionTranscriptsAfterId(sessionId, afterId, limit ?? 100, updatedSince);
      } else {
        // Pass limit to query — avoids loading entire transcript into memory
        segments = getSessionTranscripts(sessionId, limit);
      }

      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify(
            segments.map((s) => ({
              id: s.id,
              userId: s.user_id,
              displayName: s.display_name,
              speakerLabel: s.speaker_label,
              segmentStart: s.segment_start,
              segmentEnd: s.segment_end,
              transcript: s.transcript,
              confidence: s.confidence,
              isFinal: s.is_final === 1,
              sttEngine: s.stt_engine,
            }))
          ),
        }],
      };
    }
  );

  // session://{id}/text-events — text channel messages
  server.resource(
    'session-text-events',
    'session://{id}/text-events',
    { description: 'Text channel messages captured during a session' },
    async (uri) => {
      const sessionId = extractSessionId(uri.href);
      const events = getSessionTextEvents(sessionId);

      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify(
            events.map((e) => ({
              id: e.id,
              messageId: e.message_id,
              userId: e.user_id,
              channelId: e.channel_id,
              timestamp: e.message_timestamp,
              content: e.content,
              eventType: e.event_type,
            }))
          ),
        }],
      };
    }
  );

  // session://{id}/audio-tracks — track metadata
  server.resource(
    'session-audio-tracks',
    'session://{id}/audio-tracks',
    { description: 'Audio track metadata for a session' },
    async (uri) => {
      const sessionId = extractSessionId(uri.href);
      const tracks = getSessionTracks(sessionId);

      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify(
            tracks.map((t) => ({
              id: t.id,
              userId: t.user_id,
              filePath: t.file_path,
              startedAt: t.started_at,
              firstPacketAt: t.first_packet_at,
              endedAt: t.ended_at,
              codec: t.codec,
              container: t.container,
              sttStatus: t.stt_status,
              sttMode: t.stt_mode,
            }))
          ),
        }],
      };
    }
  );
}

/**
 * Wire a LiveTranscriptManager to the MCP server for real-time transcript updates.
 * When transcripts arrive, sends resource-updated notifications so subscribed clients
 * can re-read session://{id}/transcript with ?after_id= for incremental fetch.
 * Clients can also pass ?updated_since= (ISO 8601) to catch interim→final updates
 * that reuse existing row IDs.
 */
export function wireLiveTranscripts(server: McpServer, sessionId: string, liveTranscripts: LiveTranscriptManager): void {
  const uri = `session://${sessionId}/transcript`;

  liveTranscripts.on('segment', () => {
    // Notify all subscribed MCP clients that the transcript resource has been updated
    try {
      server.server.sendResourceUpdated({ uri });
    } catch {
      // Client may not be subscribed; non-critical
    }
  });
}

/** Reserved URI segments that are not session IDs. */
const RESERVED_SEGMENTS = new Set(['active', 'list']);

/** Extract session ID from a session:// URI. Returns '' for reserved keywords. */
function extractSessionId(uri: string): string {
  // Handle URIs like "session://abc-123/transcript" or "session://abc-123"
  const match = uri.match(/^session:\/\/([^/]+)/);
  const id = match?.[1] ?? '';
  // Guard: don't treat reserved route names as session UUIDs
  if (RESERVED_SEGMENTS.has(id)) return '';
  return id;
}
