import { type Client, Events, type VoiceState } from 'discord.js';
import { logger } from '../logger.js';
import {
  getActiveSessionForGuild,
  type ActiveSession,
} from '../session-manager.js';
import { insertParticipant, markParticipantLeft } from '../db/queries.js';

/**
 * Register the voiceStateUpdate listener for late joiner handling.
 * Detects when a user joins the voice channel during an active session,
 * sends them a DM notification (with dedup), and subscribes their audio.
 */
export function registerLateJoinHandler(client: Client): void {
  client.on(Events.VoiceStateUpdate, async (oldState: VoiceState, newState: VoiceState) => {
    // Only care about channel changes -- not mute/deafen/stream toggles
    if (oldState.channelId === newState.channelId) return;

    // Handle user leaving the session voice channel
    if (oldState.channelId && !newState.channelId || (oldState.channelId && newState.channelId !== oldState.channelId)) {
      handleUserLeave(oldState);
    }

    // Must have joined a channel (not just left one)
    if (!newState.channelId) return;

    const guildId = newState.guild.id;
    const session = getActiveSessionForGuild(guildId);
    if (!session) return;

    // Must have joined the session's voice channel
    if (newState.channelId !== session.voiceChannelId) return;

    const userId = newState.id;

    // Skip bots
    if (newState.member?.user.bot) return;

    // Dedup: don't notify/subscribe if already handled
    if (session.notifiedUsers.has(userId)) return;
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

    logger.info(`Late joiner: ${displayName} (${userId}) joined session ${session.id}`);

    // Notify via DM
    await notifyLateJoiner(newState, session);
  });
}

function handleUserLeave(oldState: VoiceState): void {
  const guildId = oldState.guild.id;
  const session = getActiveSessionForGuild(guildId);
  if (!session) return;
  if (oldState.channelId !== session.voiceChannelId) return;

  const userId = oldState.id;
  if (oldState.member?.user.bot) return;

  const now = new Date().toISOString();
  const displayName = oldState.member?.displayName ?? userId;

  // Close any open speech burst before closing the track
  session.burstTracker.closeUserBurst(userId);
  session.recorder.closeUserTrack(userId);
  markParticipantLeft(session.id, userId, now);

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
