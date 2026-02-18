import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client, TextChannel } from 'discord.js';
import {
  searchTranscripts,
  getParticipantSpeech,
  getSessionTranscripts,
  getSessionTextEvents,
} from '../db/queries.js';
import { getAllActiveSessions } from '../session-manager.js';
import { logger } from '../logger.js';

export function registerTools(server: McpServer, client?: Client): void {
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

  // post_image — fetch an image from Foundry's file server and post it to a Discord channel
  server.registerTool(
    'post_image',
    {
      description: 'Fetch an image from the Foundry VTT file server and post it to the session text channel',
      inputSchema: {
        imageUrl: z.string().describe('Full URL to the image on Foundry file server (e.g. http://localhost:30000/worlds/my-world/maps/map.webp)'),
        caption: z.string().optional().describe('Caption text to post with the image'),
        channelId: z.string().optional().describe('Target channel ID (defaults to first text channel of the active session)'),
      },
    },
    async ({ imageUrl, caption, channelId }) => {
      if (!client) {
        return {
          content: [{ type: 'text' as const, text: 'Error: Discord client not available' }],
          isError: true,
        };
      }

      try {
        // Determine target channel
        let targetChannelId = channelId;
        if (!targetChannelId) {
          // Find the first active session's text channel
          const sessions = getAllActiveSessions();
          if (sessions.length === 0) {
            return {
              content: [{ type: 'text' as const, text: 'Error: No active session — cannot determine target channel' }],
              isError: true,
            };
          }
          const session = sessions[0];
          targetChannelId = session.textChannelIds[0];
          if (!targetChannelId) {
            return {
              content: [{ type: 'text' as const, text: 'Error: Active session has no text channels' }],
              isError: true,
            };
          }
        }

        const channel = await client.channels.fetch(targetChannelId);
        if (!channel || !channel.isTextBased()) {
          return {
            content: [{ type: 'text' as const, text: `Error: Channel ${targetChannelId} is not a text channel` }],
            isError: true,
          };
        }

        // Fix #5a: Restrict image URLs to localhost Foundry file server only
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(imageUrl);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Error: Invalid URL: ${imageUrl}` }],
            isError: true,
          };
        }
        const allowedHosts = ['localhost', '127.0.0.1'];
        if (!allowedHosts.includes(parsedUrl.hostname) || parsedUrl.port !== '30000') {
          return {
            content: [{ type: 'text' as const, text: `Error: Only Foundry VTT localhost:30000 URLs are allowed (got: ${parsedUrl.host}).` }],
            isError: true,
          };
        }
        if (parsedUrl.protocol !== 'http:') {
          return {
            content: [{ type: 'text' as const, text: `Error: Only http: protocol is allowed for localhost Foundry URLs.` }],
            isError: true,
          };
        }

        // Fetch the image from Foundry's HTTP file server
        const MAX_IMAGE_SIZE = 25 * 1024 * 1024; // 25 MB (Discord's file upload limit)
        const response = await fetch(imageUrl);
        if (!response.ok) {
          return {
            content: [{ type: 'text' as const, text: `Error: Failed to fetch image (HTTP ${response.status}): ${imageUrl}` }],
            isError: true,
          };
        }

        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_IMAGE_SIZE) {
          return {
            content: [{ type: 'text' as const, text: `Error: Image too large (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)} MB). Discord limit is 25 MB.` }],
            isError: true,
          };
        }
        const buffer = Buffer.from(arrayBuffer);

        // Extract filename from URL path
        const urlPath = new URL(imageUrl).pathname;
        const filename = urlPath.split('/').pop() || 'image.webp';

        // Post to Discord
        const textChannel = channel as TextChannel;
        await textChannel.send({
          content: caption || undefined,
          files: [{ attachment: buffer, name: filename }],
        });

        logger.info(`post_image: posted ${filename} to channel ${targetChannelId}`);

        return {
          content: [{ type: 'text' as const, text: `Image posted: ${filename}` }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('post_image: error:', err);
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
