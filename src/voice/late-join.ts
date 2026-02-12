import { type Client, Events, type VoiceState } from 'discord.js';
import { logger } from '../logger.js';
import {
  getActiveSessionForGuild,
  teardownUserInSession,
  type ActiveSession,
} from '../session-manager.js';
import { insertParticipant, isConsentRequired, getConsent } from '../db/queries.js';
import { ffmpegRegistry } from '../stt/process-registry.js';
import { getConfig } from '../config.js';

/**
 * Register the voiceStateUpdate listener for late joiner handling.
 * Detects when a user joins the voice channel during an active session,
 * sends them a DM notification (with dedup), and subscribes their audio.
 */
export function registerLateJoinHandler(client: Client): void {
  client.on(Events.VoiceStateUpdate, async (oldState: VoiceState, newState: VoiceState) => {
    // Only care about channel changes -- not mute/deafen/stream toggles
    if (oldState.channelId === newState.channelId) return;

    // Detect if the BOT was moved to a DIFFERENT channel by an admin.
    // Only trigger when newState.channelId is non-null and different — a null channelId
    // is a transient disconnect that the reconnect handler (connection.ts) handles.
    if (newState.id === client.user?.id && newState.channelId !== null) {
      const guildId = newState.guild.id;
      const session = getActiveSessionForGuild(guildId);
      if (session && oldState.channelId === session.voiceChannelId && newState.channelId !== session.voiceChannelId) {
        logger.warn(`Bot was moved from session voice channel to ${newState.channelId} — auto-stopping session ${session.id}`);
        const { forceEndSession } = await import('../session-manager.js');
        await forceEndSession(guildId, client, 'bot moved from session voice channel');
        return;
      }
    }

    // Handle user leaving the session voice channel
    if (oldState.channelId && !newState.channelId || (oldState.channelId && newState.channelId !== oldState.channelId)) {
      handleUserLeave(oldState);
    }

    // Must have joined a channel (not just left one)
    if (!newState.channelId) return;

    const guildId = newState.guild.id;
    const session = getActiveSessionForGuild(guildId);
    if (!session) return;

    // Don't subscribe new users while session is tearing down
    if (session.tearingDown) return;

    // Must have joined the session's voice channel
    if (newState.channelId !== session.voiceChannelId) return;

    const userId = newState.id;

    // Skip bots
    if (newState.member?.user.bot) return;

    // Dedup: don't notify/subscribe if already handled
    if (session.notifiedUsers.has(userId)) return;

    // Check consent if required (before subscribing)
    if (isConsentRequired(guildId)) {
      const consent = getConsent(guildId, userId);
      if (!consent || consent.consented !== 1) {
        logger.info(`Late joiner ${userId}: skipping (no consent)`);
        // Still notify them about the recording, but don't subscribe
        await notifyLateJoiner(newState, session);
        return;
      }
    }

    session.notifiedUsers.add(userId);

    const now = new Date().toISOString();
    const displayName = newState.member?.displayName ?? userId;

    // Log as participant
    insertParticipant({
      sessionId: session.id,
      userId,
      displayName,
      joinedAt: now,
    });

    // Subscribe to audio
    session.recorder.subscribeUser(userId);

    // Spawn ffmpeg resampler and add to STT processor if enabled
    if (getConfig().stt.enabled) {
      if (!session.diarized) {
        // Per-user mode: each participant gets their own ffmpeg + gate
        ffmpegRegistry.spawn(userId, session.id);

        if (session.sttProcessor) {
          session.sttProcessor.addUser(userId);
        }
      } else if (userId === session.gmUserId) {
        // Diarized mode: only the GM gets ffmpeg + gate (e.g., GM rejoin after disconnect)
        ffmpegRegistry.spawn(userId, session.id);
        session.sttProcessor?.addUser(userId);
      }

      // Register new track and display name in transcript writer
      if (session.transcriptWriter) {
        const track = session.recorder.getTrack(userId);
        if (track) {
          session.transcriptWriter.setUserTrackId(userId, track.trackId);
          // In diarized mode, also register the diarized userId key
          if (session.diarized && userId === session.gmUserId) {
            session.transcriptWriter.setUserTrackId(`diarized:${userId}`, track.trackId);
          }
        }
        session.transcriptWriter.setUserDisplayName(userId, displayName);
      }
    }

    logger.info(`Late joiner: ${displayName} (${userId}) joined session ${session.id}`);

    // Notify via DM
    await notifyLateJoiner(newState, session);
  });
}

function handleUserLeave(oldState: VoiceState): void {
  const guildId = oldState.guild.id;
  const session = getActiveSessionForGuild(guildId);
  if (!session) return;
  if (session.tearingDown) return;
  if (oldState.channelId !== session.voiceChannelId) return;

  const userId = oldState.id;
  if (oldState.member?.user.bot) return;

  const displayName = oldState.member?.displayName ?? userId;
  teardownUserInSession(session, userId);
  logger.info(`User left: ${displayName} (${userId}) left session ${session.id}`);
}

async function notifyLateJoiner(voiceState: VoiceState, session: ActiveSession): Promise<void> {
  const member = voiceState.member;
  if (!member) return;

  const channelName = voiceState.channel?.name ?? 'the voice channel';
  const message = `A recording session is in progress in #${channelName}.`;

  try {
    const dm = await member.createDM();
    await dm.send(message);
    logger.debug(`DM sent to late joiner ${member.user.tag}`);
  } catch {
    // DMs disabled -- fall back to a channel message
    logger.debug(`Could not DM ${member.user.tag}, falling back to channel message`);
    try {
      const guild = voiceState.guild;
      // Try to use the first text channel from the session
      if (session.textChannelIds.length > 0) {
        const ch = await guild.channels.fetch(session.textChannelIds[0]);
        if (ch && ch.isTextBased() && 'send' in ch) {
          await (ch as import('discord.js').TextChannel).send(
            `${member}, a recording session is in progress in #${channelName}.`
          );
        }
      }
    } catch {
      logger.warn(`Could not notify late joiner ${member.user.tag} via any channel`);
    }
  }
}
