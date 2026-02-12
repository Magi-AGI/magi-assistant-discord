import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  searchTranscripts,
  getParticipantSpeech,
  getSessionTranscripts,
  getSessionTextEvents,
} from '../db/queries.js';

export function registerTools(server: McpServer): void {
  // search_transcripts — full-text search
  server.registerTool(
    'search_transcripts',
    {
      description: 'Search transcript segments by text content',
      inputSchema: {
        sessionId: z.string().describe('Session ID to search in'),
        query: z.string().describe('Text to search for in transcripts'),
      },
    },
    async ({ sessionId, query }) => {
      const results = searchTranscripts(sessionId, query);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(
            results.map((s) => ({
              id: s.id,
              userId: s.user_id,
              displayName: s.display_name,
              segmentStart: s.segment_start,
              transcript: s.transcript,
              confidence: s.confidence,
              isFinal: s.is_final === 1,
            }))
          ),
        }],
      };
    }
  );

  // get_session_timeline — interleaved chronological view
  server.registerTool(
    'get_session_timeline',
    {
      description: 'Get an interleaved chronological view of transcripts and text events',
      inputSchema: {
        sessionId: z.string().describe('Session ID'),
      },
    },
    async ({ sessionId }) => {
      const transcripts = getSessionTranscripts(sessionId);
      const textEvents = getSessionTextEvents(sessionId);

      const timeline: Array<{
        type: 'transcript' | 'text';
        timestamp: string;
        userId: string | null;
        displayName: string | null;
        content: string | null;
      }> = [];

      for (const t of transcripts) {
        if (!t.is_final) continue;
        timeline.push({
          type: 'transcript',
          timestamp: t.segment_start,
          userId: t.user_id,
          displayName: t.display_name,
          content: t.transcript,
        });
      }

      for (const e of textEvents) {
        if (e.event_type !== 'create') continue;
        timeline.push({
          type: 'text',
          timestamp: e.event_received_at,
          userId: e.user_id,
          displayName: null,
          content: e.content,
        });
      }

      timeline.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(timeline),
        }],
      };
    }
  );

  // get_participant_speech — all speech from one participant
  server.registerTool(
    'get_participant_speech',
    {
      description: 'Get all speech from a specific participant',
      inputSchema: {
        sessionId: z.string().describe('Session ID'),
        userId: z.string().describe('User ID of the participant'),
      },
    },
    async ({ sessionId, userId }) => {
      const segments = getParticipantSpeech(sessionId, userId);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(
            segments.map((s) => ({
              id: s.id,
              segmentStart: s.segment_start,
              segmentEnd: s.segment_end,
              transcript: s.transcript,
              confidence: s.confidence,
              isFinal: s.is_final === 1,
              speakerLabel: s.speaker_label,
            }))
          ),
        }],
      };
    }
  );
}
