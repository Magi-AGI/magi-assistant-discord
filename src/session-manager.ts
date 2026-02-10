import {
  type VoiceConnection,
  type VoiceReceiver,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import {
  type ChatInputCommandInteraction,
  type Client,
  type TextChannel,
  ChannelType,
  EmbedBuilder,
} from 'discord.js';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import * as fs from 'fs';
import { getConfig } from './config.js';
import { logger } from './logger.js';
import {
  insertSession,
  getActiveSession,
  endSession,
  insertParticipant,
  markParticipantLeft,
  getSessionParticipants,
  getSessionTracks,
} from './db/queries.js';
import { SessionRecorder } from './voice/recorder.js';
import { BurstTracker } from './voice/burst-tracker.js';

/** Runtime state for an active recording session. */
export interface ActiveSession {
  id: string;
  guildId: string;
  voiceChannelId: string;
  textChannelIds: string[];
  connection: VoiceConnection;
  receiver: VoiceReceiver;
  startedAt: Date;
  statusMessageId: string | null;
  statusChannelId: string | null;
  originalNickname: string | null;
  nicknameChanged: boolean;
  statusPinned: boolean;
  recorder: SessionRecorder;
  burstTracker: BurstTracker;
  notifiedUsers: Set<string>;
}

// One active session per guild
const activeSessions = new Map<string, ActiveSession>();

// Per-guild lock to prevent concurrent /session start races
const startLocks = new Set<string>();

export function getActiveSessionForGuild(guildId: string): ActiveSession | undefined {
  return activeSessions.get(guildId);
}

export function getAllActiveSessions(): ActiveSession[] {
  return Array.from(activeSessions.values());
}

export async function startSession(
  interaction: ChatInputCommandInteraction,
  channelOverride: TextChannel | null
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    return;
  }

  // Per-guild lock to prevent concurrent start races
  if (startLocks.has(guild.id)) {
    await interaction.reply({
      content: 'A session start is already in progress. Please wait.',
      ephemeral: true,
    });
    return;
  }

  // Fetch the full GuildMember to ensure voice state is populated
  const member = await guild.members.fetch(interaction.user.id);
  const voiceChannel = member.voice.channel;
  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    await interaction.reply({
      content: 'You must be in a voice channel to start a recording session.',
      ephemeral: true,
    });
    return;
  }

  // Single-session guard
  const existing = getActiveSession(guild.id);
  if (existing) {
    await interaction.reply({
      content: `A session is already active (session ID: ${existing.id}). Use \`/session stop\` to end it first.`,
      ephemeral: true,
    });
    return;
  }

  // Also check runtime state (belt + suspenders)
  if (activeSessions.has(guild.id)) {
    await interaction.reply({
      content: 'A session is already running in this server. Use `/session stop` to end it first.',
      ephemeral: true,
    });
    return;
  }

  startLocks.add(guild.id);

  try {
    await interaction.deferReply();

    const config = getConfig();
    const guildConfig = config.guilds[guild.id];

    // Determine text channels to monitor
    const textChannelIds: string[] = channelOverride
      ? [channelOverride.id]
      : (guildConfig?.textChannels ?? []);

    const sessionId = uuidv4();
    const now = new Date();
    const timezone = guildConfig?.timezone ?? 'UTC';

    // Create session directory
    const sessionDir = path.resolve(config.dataDir, sessionId);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    // Insert session record
    insertSession({
      id: sessionId,
      guildId: guild.id,
      voiceChannelId: voiceChannel.id,
      textChannelIds,
      timezone,
      startedAt: now.toISOString(),
    });

    // Join voice channel
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch {
      connection.destroy();
      endSession(sessionId, new Date().toISOString(), 'error');
      await interaction.editReply('Failed to join voice channel (timeout).');
      return;
    }

    const receiver = connection.receiver;

    // Build runtime session state
    const recorder = new SessionRecorder(sessionId, receiver);
    const burstTracker = new BurstTracker(sessionId, recorder, receiver);
    const session: ActiveSession = {
      id: sessionId,
      guildId: guild.id,
      voiceChannelId: voiceChannel.id,
      textChannelIds,
      connection,
      receiver,
      startedAt: now,
      statusMessageId: null,
      statusChannelId: null,
      originalNickname: null,
      nicknameChanged: false,
      statusPinned: false,
      recorder,
      burstTracker,
      notifiedUsers: new Set(),
    };

    activeSessions.set(guild.id, session);

    // Log initial participants
    for (const [, vcMember] of voiceChannel.members) {
      if (vcMember.user.bot) continue;
      insertParticipant({
        sessionId,
        userId: vcMember.id,
        displayName: vcMember.displayName,
        joinedAt: now.toISOString(),
      });
      session.notifiedUsers.add(vcMember.id);
      recorder.subscribeUser(vcMember.id);
    }

    // Recording indicator: nickname
    try {
      const botMember = guild.members.me;
      if (botMember) {
        session.originalNickname = botMember.nickname;
        await botMember.setNickname('[REC] Magi Assistant');
        session.nicknameChanged = true;
      }
    } catch {
      logger.warn('Could not set bot nickname (missing Manage Nicknames permission)');
    }

    // Recording indicator: status embed
    const statusEmbed = new EmbedBuilder()
      .setColor(0xff0000)
      .setTitle('\u{1f534} Recording session in progress')
      .addFields(
        { name: 'Session ID', value: sessionId, inline: true },
        { name: 'Started', value: `<t:${Math.floor(now.getTime() / 1000)}:F>`, inline: true },
        { name: 'Voice Channel', value: voiceChannel.name, inline: true }
      )
      .setTimestamp();

    const statusChannel = interaction.channel;
    if (statusChannel && statusChannel.isTextBased() && 'send' in statusChannel) {
      try {
        const statusMsg = await (statusChannel as TextChannel).send({ embeds: [statusEmbed] });
        session.statusMessageId = statusMsg.id;
        session.statusChannelId = statusChannel.id;

        // Try to pin
        try {
          await statusMsg.pin();
          session.statusPinned = true;
        } catch {
          logger.warn('Could not pin status message (missing Manage Messages permission)');
        }
      } catch (err) {
        logger.warn('Could not send status embed:', err);
      }
    }

    const participantCount = voiceChannel.members.filter((m) => !m.user.bot).size;
    await interaction.editReply(
      `Recording session started in **${voiceChannel.name}** with ${participantCount} participant(s).\nSession ID: \`${sessionId}\``
    );

    logger.info(`Session ${sessionId} started in guild ${guild.id}, voice channel ${voiceChannel.name}`);
  } finally {
    startLocks.delete(guild.id);
  }
}

export async function stopSession(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    return;
  }

  const session = activeSessions.get(guild.id);
  if (!session) {
    await interaction.reply({ content: 'No active recording session in this server.', ephemeral: true });
    return;
  }

  await interaction.deferReply();

  const now = new Date();

  // Close all open speech bursts, then close audio streams
  session.burstTracker.destroy();
  session.recorder.closeAll();
  // TODO (Step 8): Remove text listeners

  // Mark all participants as left
  const participants = getSessionParticipants(session.id);
  for (const p of participants) {
    if (!p.left_at) {
      markParticipantLeft(session.id, p.user_id, now.toISOString());
    }
  }

  // Destroy voice connection
  session.connection.destroy();

  // Update DB
  endSession(session.id, now.toISOString(), 'stopped');

  // Restore nickname
  await restoreNickname(guild, session);

  // Unpin status message
  await unpinStatusMessage(guild, session);

  // Clean up runtime state
  activeSessions.delete(guild.id);

  // Build summary
  const duration = now.getTime() - session.startedAt.getTime();
  const durationStr = formatDuration(duration);
  const tracks = getSessionTracks(session.id);
  const participantNames = participants.map((p) => p.display_name).join(', ');

  await interaction.editReply(
    `Recording session stopped.\n` +
    `**Duration:** ${durationStr}\n` +
    `**Participants:** ${participantNames || 'none'}\n` +
    `**Audio tracks:** ${tracks.length}\n` +
    `**Session ID:** \`${session.id}\`\n\n` +
    `> Raw audio files contain speech only. Run \`npm run hydrate-audio ${session.id}\` to generate listenable files with silence gaps restored.`
  );

  logger.info(`Session ${session.id} stopped. Duration: ${durationStr}, Tracks: ${tracks.length}`);
}

export async function sessionStatus(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    return;
  }

  const session = activeSessions.get(guild.id);
  if (!session) {
    await interaction.reply({ content: 'No active recording session in this server.', ephemeral: true });
    return;
  }

  const now = new Date();
  const duration = now.getTime() - session.startedAt.getTime();
  const durationStr = formatDuration(duration);

  const participants = getSessionParticipants(session.id);
  const activeParticipants = participants.filter((p) => !p.left_at);
  const participantList = activeParticipants.map((p) => p.display_name).join(', ') || 'none';

  const tracks = getSessionTracks(session.id);

  // Disk usage
  let diskInfo = 'unavailable';
  try {
    const config = getConfig();
    const stats = fs.statfsSync(path.resolve(config.dataDir));
    const freeGB = (stats.bfree * stats.bsize) / (1024 * 1024 * 1024);
    diskInfo = `${freeGB.toFixed(1)} GB free`;
  } catch {
    // statfsSync may not be available on all platforms
  }

  // Event loop lag placeholder (will be wired in Step 10)
  const lagInfo = 'monitoring not yet active';

  const embed = new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle('\u{1f534} Recording Session Status')
    .addFields(
      { name: 'Session ID', value: `\`${session.id}\``, inline: false },
      { name: 'Duration', value: durationStr, inline: true },
      { name: 'Active Participants', value: participantList, inline: true },
      { name: 'Audio Tracks', value: `${tracks.length}`, inline: true },
      { name: 'Disk Space', value: diskInfo, inline: true },
      { name: 'Event Loop Lag', value: lagInfo, inline: true }
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// --- Helpers ---

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (h > 0) {
    return `${h}h ${m}m ${s}s`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

async function restoreNickname(
  guild: import('discord.js').Guild,
  session: ActiveSession
): Promise<void> {
  if (!session.nicknameChanged) return;
  try {
    const botMember = guild.members.me;
    if (botMember) {
      await botMember.setNickname(session.originalNickname);
    }
  } catch {
    logger.warn('Could not restore bot nickname');
  }
}

async function unpinStatusMessage(
  guild: import('discord.js').Guild,
  session: ActiveSession
): Promise<void> {
  if (!session.statusPinned || !session.statusMessageId || !session.statusChannelId) return;
  try {
    const ch = await guild.channels.fetch(session.statusChannelId);
    if (ch && ch.isTextBased()) {
      const textCh = ch as TextChannel;
      const msg = await textCh.messages.fetch(session.statusMessageId);
      await msg.unpin();
    }
  } catch {
    logger.warn('Could not unpin status message');
  }
}

/**
 * Called during graceful shutdown to cleanly stop all active sessions.
 * Best-effort: restores nicknames and unpins status messages.
 */
export async function shutdownAllSessions(client?: Client): Promise<void> {
  for (const [guildId, session] of activeSessions) {
    const now = new Date().toISOString();

    // Close all open speech bursts, then close audio streams
    session.burstTracker.destroy();
    session.recorder.closeAll();

    // Mark participants as left
    const participants = getSessionParticipants(session.id);
    for (const p of participants) {
      if (!p.left_at) {
        markParticipantLeft(session.id, p.user_id, now);
      }
    }

    // Best-effort cleanup of Discord indicators
    if (client) {
      try {
        const guild = await client.guilds.fetch(guildId);
        await restoreNickname(guild, session);
        await unpinStatusMessage(guild, session);
      } catch {
        logger.warn(`Shutdown: could not clean up indicators for guild ${guildId}`);
      }
    }

    session.connection.destroy();
    endSession(session.id, now, 'stopped');
    logger.info(`Shutdown: stopped session ${session.id} in guild ${guildId}`);
  }
  activeSessions.clear();
}
