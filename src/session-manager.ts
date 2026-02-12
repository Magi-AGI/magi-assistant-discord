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
  MessageFlags,
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
  isConsentRequired,
  getConsent,
} from './db/queries.js';
import { SessionRecorder } from './voice/recorder.js';
import { BurstTracker } from './voice/burst-tracker.js';
import { registerReconnectHandler } from './voice/connection.js';
import { getEventLoopLagMs, getFreeDiskGB } from './monitoring.js';
import { checkVoicePermissions, checkTextPermissions, checkManageMessages, checkNicknamePermission, formatMissingPermissions } from './utils/permissions.js';
import { withRateLimitRetry } from './utils/rate-limit.js';
import { ffmpegRegistry } from './stt/process-registry.js';
import type { SttProcessor } from './stt/stt-processor.js';
import type { TranscriptWriter } from './stt/transcript-writer.js';
import type { SttUsageTracker } from './stt/usage-tracker.js';
import type { LiveTranscriptManager } from './mcp/live-subscriptions.js';

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
  diarized: boolean;
  /** The user ID of the GM who started the session (used for diarized mode STT lifecycle). */
  gmUserId: string;
  sttProcessor: SttProcessor | null;
  transcriptWriter: TranscriptWriter | null;
  usageTracker: SttUsageTracker | null;
  liveTranscripts: LiveTranscriptManager | null;
  resyncTimer: ReturnType<typeof setInterval> | null;
  /** Set at start of teardown to prevent in-flight resync callbacks from mutating state. */
  tearingDown: boolean;
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
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  // Per-guild lock to prevent concurrent start races
  if (startLocks.has(guild.id)) {
    await interaction.reply({
      content: 'A session start is already in progress. Please wait.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Fetch the full GuildMember to ensure voice state is populated
  const member = await guild.members.fetch(interaction.user.id);
  const voiceChannel = member.voice.channel;
  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    await interaction.reply({
      content: 'You must be in a voice channel to start a recording session.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Single-session guard
  const existing = getActiveSession(guild.id);
  if (existing) {
    await interaction.reply({
      content: `A session is already active (session ID: ${existing.id}). Use \`/session stop\` to end it first.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Also check runtime state (belt + suspenders)
  if (activeSessions.has(guild.id)) {
    await interaction.reply({
      content: 'A session is already running in this server. Use `/session stop` to end it first.',
      flags: MessageFlags.Ephemeral,
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

    // Permission pre-checks
    const voicePerms = checkVoicePermissions(voiceChannel as unknown as import('discord.js').GuildChannel);
    if (!voicePerms.ok) {
      await interaction.editReply(formatMissingPermissions(voicePerms.missing) + ` in voice channel **${voiceChannel.name}**.`);
      return;
    }

    const statusChannel = interaction.channel;
    if (statusChannel && 'guild' in statusChannel && statusChannel.guild) {
      const textPerms = checkTextPermissions(statusChannel as unknown as import('discord.js').GuildChannel);
      if (!textPerms.ok) {
        await interaction.editReply(formatMissingPermissions(textPerms.missing) + ` in text channel.`);
        return;
      }
    }

    // Pre-flight warnings for optional permissions (non-blocking)
    const nickPerms = checkNicknamePermission(guild);
    if (!nickPerms.ok) {
      logger.warn(`Pre-flight: missing ${nickPerms.missing.join(', ')} in guild ${guild.id} — nickname indicator will be skipped`);
    }
    if (statusChannel && 'guild' in statusChannel && statusChannel.guild) {
      const msgPerms = checkManageMessages(statusChannel as unknown as import('discord.js').GuildChannel);
      if (!msgPerms.ok) {
        logger.warn(`Pre-flight: missing ${msgPerms.missing.join(', ')} — status message pin will be skipped`);
      }
    }

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

    // Register voice reconnection handler (exponential backoff, 3 attempts)
    const clientRef = interaction.client;
    registerReconnectHandler(connection, sessionId, async () => {
      await forceEndSession(guild.id, clientRef, 'voice disconnect');
    });

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
      diarized: false,
      gmUserId: interaction.user.id,
      sttProcessor: null,
      transcriptWriter: null,
      usageTracker: null,
      liveTranscripts: null,
      resyncTimer: null,
      tearingDown: false,
    };

    activeSessions.set(guild.id, session);

    // Read diarized option early so participant loop knows whether to spawn ffmpeg
    const diarizedOption = config.stt.enabled
      ? (interaction.options.getBoolean('diarized') ?? false)
      : false;
    session.diarized = diarizedOption;

    // Log initial participants (with consent check)
    const consentRequired = isConsentRequired(guild.id);
    const gmUserId = interaction.user.id;
    for (const [, vcMember] of voiceChannel.members) {
      if (vcMember.user.bot) continue;

      // Check consent if required
      if (consentRequired) {
        const consent = getConsent(guild.id, vcMember.id);
        if (!consent || consent.consented !== 1) {
          logger.info(`Skipping user ${vcMember.id} (no consent) for session ${sessionId}`);
          continue;
        }
      }

      insertParticipant({
        sessionId,
        userId: vcMember.id,
        displayName: vcMember.displayName,
        joinedAt: now.toISOString(),
      });
      session.notifiedUsers.add(vcMember.id);
      recorder.subscribeUser(vcMember.id);

      // Spawn ffmpeg resampler for STT if enabled
      // In diarized mode, only GM needs ffmpeg (other users are still recorded but not transcribed)
      if (config.stt.enabled && (!diarizedOption || vcMember.id === gmUserId)) {
        ffmpegRegistry.spawn(vcMember.id, sessionId);
      }
    }

    // Set up STT processor if enabled
    if (config.stt.enabled) {
      let engineAcquired = false;
      let sttOnStart: ((userId: string) => void) | null = null;
      let sttOnEnd: ((userId: string) => void) | null = null;
      try {
        const { acquireSttEngine } = await import('./stt/engine-factory.js');
        const { SttProcessor } = await import('./stt/stt-processor.js');

        const engine = acquireSttEngine(config.stt, diarizedOption);
        engineAcquired = true;
        const sttProcessor = new SttProcessor(engine, config.stt, sessionId);
        session.sttProcessor = sttProcessor;

        if (diarizedOption) {
          // Diarized mode: only the GM's stream is used
          sttProcessor.addUser(gmUserId);
          logger.info(`STT diarized mode: using GM stream (${gmUserId}) for session ${sessionId}`);
        } else {
          // Per-user mode: add all current consented participants
          for (const [, vcMember] of voiceChannel.members) {
            if (vcMember.user.bot) continue;
            // Only add users who were actually subscribed (passed consent check)
            if (session.notifiedUsers.has(vcMember.id)) {
              sttProcessor.addUser(vcMember.id);
            }
          }
        }

        // Register speaking listeners for VAD gating
        // (store refs in outer scope for cleanup on partial init failure)
        sttOnStart = (userId: string) => sttProcessor.onSpeakingStart(userId);
        sttOnEnd = (userId: string) => sttProcessor.onSpeakingEnd(userId);
        receiver.speaking.on('start', sttOnStart);
        receiver.speaking.on('end', sttOnEnd);

        // Set up transcript writer and usage tracker
        const { TranscriptWriter } = await import('./stt/transcript-writer.js');
        const { SttUsageTracker } = await import('./stt/usage-tracker.js');
        const writer = new TranscriptWriter(sessionId);
        const usageTracker = new SttUsageTracker(sessionId, config.stt);
        session.transcriptWriter = writer;
        session.usageTracker = usageTracker;

        // Set up live transcript manager and wire to MCP
        const { LiveTranscriptManager } = await import('./mcp/live-subscriptions.js');
        const liveTranscripts = new LiveTranscriptManager(config.stt.interimThrottlePerSecond);
        session.liveTranscripts = liveTranscripts;

        // Wire live transcripts to MCP server for resource-updated notifications
        const { getMcpServer } = await import('./mcp/server.js');
        const { wireLiveTranscripts } = await import('./mcp/resources.js');
        const mcpSrv = getMcpServer();
        if (mcpSrv) {
          wireLiveTranscripts(mcpSrv, sessionId, liveTranscripts);
        }

        // Register track IDs and display names for burst mapping + attribution
        for (const track of recorder.getAllTracks()) {
          writer.setUserTrackId(track.userId, track.trackId);
        }
        for (const [, vcMember] of voiceChannel.members) {
          if (!vcMember.user.bot && session.notifiedUsers.has(vcMember.id)) {
            writer.setUserDisplayName(vcMember.id, vcMember.displayName);
          }
        }

        // For diarized mode, also register the diarized userId key
        // (the diarized engine emits userId as "diarized:<gmUserId>")
        if (diarizedOption) {
          const gmTrack = recorder.getTrack(gmUserId);
          if (gmTrack) {
            writer.setUserTrackId(`diarized:${gmUserId}`, gmTrack.trackId);
          }
        }

        // Wire transcript events to writer and live subscriptions
        sttProcessor.on('transcript', (event: import('./stt/types.js').TranscriptEvent) => {
          const rowId = writer.write(event);
          if (rowId !== null) {
            liveTranscripts.onTranscriptStored(rowId, event);
          }
        });

        // Wire speech duration events from VAD gate to usage tracker
        // (more accurate than deriving from segment timestamps)
        sttProcessor.on('speechDuration', (durationMs: number) => {
          usageTracker.addSpeechDuration(durationMs);
        });

        logger.info(`STT processor initialized for session ${sessionId} (diarized=${diarizedOption})`);
      } catch (err) {
        logger.error('Failed to initialize STT processor:', err);
        // Clean up partially initialized STT state
        if (session.sttProcessor) {
          // Remove speaking listeners that may have been attached
          if (sttOnStart) receiver.speaking.off('start', sttOnStart);
          if (sttOnEnd) receiver.speaking.off('end', sttOnEnd);
          session.sttProcessor.destroy();
          session.sttProcessor = null;
        }
        session.transcriptWriter = null;
        session.usageTracker = null;
        session.liveTranscripts?.destroy();
        session.liveTranscripts = null;
        // Release engine if acquired (prevents gRPC refcount leak)
        if (engineAcquired) {
          try {
            const { releaseSttEngine } = await import('./stt/engine-factory.js');
            releaseSttEngine(config.stt, diarizedOption);
          } catch { /* engine module not loaded */ }
        }
      }
    }

    // Resync heartbeat: periodically reconcile voice channel members against tracked users.
    // Catches missed Gateway events (rare but possible during network hiccups).
    const resyncClient = interaction.client;
    session.resyncTimer = setInterval(() => {
      resyncVoiceMembers(session, resyncClient).catch((err) => {
        logger.debug('Resync heartbeat error:', err);
      });
    }, 60_000);

    // Recording indicator: nickname
    try {
      const botMember = guild.members.me;
      if (botMember) {
        session.originalNickname = botMember.nickname;
        await withRateLimitRetry(() => botMember.setNickname('[REC] Magi Assistant'));
        session.nicknameChanged = true;
      } else {
        logger.warn('Could not set bot nickname: guild.members.me is null');
      }
    } catch (err) {
      logger.warn('Could not set bot nickname (missing Manage Nicknames permission?):', err);
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

    const statusCh = interaction.channel;
    if (statusCh && statusCh.isTextBased() && 'send' in statusCh) {
      try {
        const statusMsg = await withRateLimitRetry(() => (statusCh as TextChannel).send({ embeds: [statusEmbed] }));
        session.statusMessageId = statusMsg.id;
        session.statusChannelId = statusCh.id;

        // Try to pin
        try {
          await withRateLimitRetry(() => statusMsg.pin());
          session.statusPinned = true;
        } catch {
          logger.warn('Could not pin status message (missing Manage Messages permission)');
        }
      } catch (err) {
        logger.warn('Could not send status embed:', err);
      }
    } else {
      logger.warn(
        `Could not send status embed: channel=${statusChannel?.id ?? 'null'}, ` +
        `isTextBased=${statusChannel?.isTextBased?.() ?? 'N/A'}, ` +
        `type=${statusChannel?.type ?? 'N/A'}`
      );
    }

    const participantCount = session.notifiedUsers.size;
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
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const session = activeSessions.get(guild.id);
  if (!session) {
    await interaction.reply({ content: 'No active recording session in this server.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply();

  const now = new Date();

  // Mark teardown to prevent in-flight resync from mutating state
  session.tearingDown = true;

  let dbEnded = false;
  try {
    // Stop resync heartbeat
    if (session.resyncTimer) {
      clearInterval(session.resyncTimer);
      session.resyncTimer = null;
    }

    // Destroy live transcripts and STT processor (destroy emits final speechDuration)
    session.liveTranscripts?.destroy();
    session.sttProcessor?.destroy();

    // Flush STT usage tracking AFTER destroy (captures final speech durations)
    session.usageTracker?.flush();
    await releaseSessionEngine(session);

    // Kill ffmpeg resamplers for this session's participants only
    const sessionParticipants = getSessionParticipants(session.id);
    for (const p of sessionParticipants) {
      ffmpegRegistry.kill(p.user_id, session.id);
    }

    // Close all open speech bursts, then close audio streams
    session.burstTracker.destroy();
    session.recorder.closeAll();

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
    dbEnded = true;

    // Restore nickname
    await restoreNickname(guild, session);

    // Unpin status message
    await unpinStatusMessage(guild, session);
  } finally {
    // Safety net: ensure DB is marked as ended even if teardown throws before endSession
    if (!dbEnded) {
      try { endSession(session.id, now.toISOString(), 'error'); } catch { /* DB may be closed */ }
    }
    // ALWAYS clean up runtime state — prevents "stuck guild" on teardown errors
    activeSessions.delete(guild.id);
  }

  // Build summary
  const duration = now.getTime() - session.startedAt.getTime();
  const durationStr = formatDuration(duration);
  const tracks = getSessionTracks(session.id);
  const finalParticipants = getSessionParticipants(session.id);
  const participantNames = finalParticipants.map((p: { display_name: string }) => p.display_name).join(', ');

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
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const session = activeSessions.get(guild.id);
  if (!session) {
    await interaction.reply({ content: 'No active recording session in this server.', flags: MessageFlags.Ephemeral });
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
  const freeGB = getFreeDiskGB();
  const diskInfo = freeGB !== null ? `${freeGB.toFixed(1)} GB free` : 'unavailable';

  // Event loop lag
  const lagMs = getEventLoopLagMs();
  const lagInfo = lagMs !== null ? `${lagMs.toFixed(1)}ms (p99)` : 'unavailable';

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

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// --- Helpers ---

/**
 * Tear down all recording/STT state for a single user leaving a session.
 * Shared by late-join handler, resync heartbeat, and consent revoke.
 */
export function teardownUserInSession(session: ActiveSession, userId: string): void {
  // Remove from STT processor before killing ffmpeg
  if (session.sttProcessor) {
    if (!session.diarized || userId === session.gmUserId) {
      session.sttProcessor.removeUser(userId);
    }
  }

  // Kill ffmpeg resampler
  ffmpegRegistry.kill(userId, session.id);

  // Close any open speech burst before closing the track
  session.burstTracker.closeUserBurst(userId);
  session.recorder.closeUserTrack(userId);

  // Mark participant as left in DB
  markParticipantLeft(session.id, userId, new Date().toISOString());

  // Clear from notifiedUsers so they can be re-subscribed on rejoin
  session.notifiedUsers.delete(userId);
}

/** Release the refcounted STT engine for a session (safe to call if STT is disabled). */
async function releaseSessionEngine(session: ActiveSession): Promise<void> {
  if (!session.sttProcessor) return;
  try {
    const { releaseSttEngine } = await import('./stt/engine-factory.js');
    const config = getConfig();
    releaseSttEngine(config.stt, session.diarized);
  } catch {
    // STT module not loaded or engine already cleaned up
  }
}

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

/**
 * Resync heartbeat: reconcile voice channel members against tracked users.
 * Discovers missed joins AND missed leaves (rare Gateway drops).
 */
async function resyncVoiceMembers(session: ActiveSession, client: Client): Promise<void> {
  // Guard against racing with teardown (async callback may still be in-flight)
  if (session.tearingDown) return;

  try {
    const guild = await client.guilds.fetch(session.guildId);

    // Re-check after await — teardown may have started during the fetch
    if (session.tearingDown) return;

    const config = getConfig();
    const consentRequired = isConsentRequired(session.guildId);

    // Get current voice channel members from cached voice states
    const voiceStates = guild.voiceStates.cache.filter(
      (vs) => vs.channelId === session.voiceChannelId && vs.member !== null && !vs.member.user.bot
    );

    // Build set of user IDs currently in the voice channel
    const currentVoiceUserIds = new Set<string>();

    // --- Detect missed joins ---
    for (const [, vs] of voiceStates) {
      const member = vs.member!;
      const userId = member.id;
      currentVoiceUserIds.add(userId);

      // Skip if consent required and not granted
      if (consentRequired) {
        const consent = getConsent(session.guildId, userId);
        if (!consent || consent.consented !== 1) continue;
      }

      // Skip if already tracked
      if (session.notifiedUsers.has(userId)) continue;

      // Missed user — full subscribe
      insertParticipant({
        sessionId: session.id,
        userId,
        displayName: member.displayName,
        joinedAt: new Date().toISOString(),
      });
      session.recorder.subscribeUser(userId);
      session.notifiedUsers.add(userId);

      // Wire STT pipeline if enabled (per-user mode, or diarized GM)
      if (config.stt.enabled && (!session.diarized || userId === session.gmUserId)) {
        ffmpegRegistry.spawn(userId, session.id);
        session.sttProcessor?.addUser(userId);
        if (session.transcriptWriter) {
          const track = session.recorder.getTrack(userId);
          if (track) {
            session.transcriptWriter.setUserTrackId(userId, track.trackId);
            if (session.diarized) {
              session.transcriptWriter.setUserTrackId(`diarized:${userId}`, track.trackId);
            }
          }
          session.transcriptWriter.setUserDisplayName(userId, member.displayName);
        }
      }

      logger.info(`Resync: discovered and subscribed ${member.user.tag} in session ${session.id}`);
    }

    // --- Detect missed leaves ---
    // Snapshot the set — teardownUserInSession() mutates notifiedUsers via .delete()
    for (const userId of [...session.notifiedUsers]) {
      if (currentVoiceUserIds.has(userId)) continue;

      logger.info(`Resync: user ${userId} left voice channel (missed leave event), cleaning up in session ${session.id}`);
      teardownUserInSession(session, userId);
    }
  } catch (err) {
    logger.debug('Resync: could not fetch voice channel members:', err);
  }
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
  ffmpegRegistry.killAll();

  // Shutdown all sessions in parallel to avoid sequential bottleneck
  // (prevents systemd/PM2 SIGKILL on slow multi-guild teardowns)
  const shutdownPromises = [...activeSessions.entries()].map(
    async ([guildId, session]) => {
      const now = new Date().toISOString();

      // Mark teardown to prevent in-flight resync from mutating state
      session.tearingDown = true;

      let dbEnded = false;
      try {
        // Stop resync heartbeat
        if (session.resyncTimer) {
          clearInterval(session.resyncTimer);
          session.resyncTimer = null;
        }

        // Destroy STT processor (destroy emits final speechDuration)
        session.sttProcessor?.destroy();

        // Flush STT usage tracking AFTER destroy (captures final speech durations)
        session.usageTracker?.flush();

        await releaseSessionEngine(session);

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
        dbEnded = true;
        logger.info(`Shutdown: stopped session ${session.id} in guild ${guildId}`);
      } finally {
        if (!dbEnded) {
          try { endSession(session.id, now, 'error'); } catch { /* DB may be closed */ }
        }
      }
    }
  );

  await Promise.allSettled(shutdownPromises);
  activeSessions.clear();
}

/**
 * Force-end a session due to unrecoverable voice disconnect.
 * Cleans up all resources and notifies the GM via channel message.
 */
export async function forceEndSession(guildId: string, client: Client, reason: string): Promise<void> {
  const session = activeSessions.get(guildId);
  if (!session) return;

  const now = new Date();

  // Mark teardown to prevent in-flight resync from mutating state
  session.tearingDown = true;

  let dbEnded = false;
  try {
    // Stop resync heartbeat
    if (session.resyncTimer) {
      clearInterval(session.resyncTimer);
      session.resyncTimer = null;
    }

    // Destroy live transcripts and STT processor (destroy emits final speechDuration)
    session.liveTranscripts?.destroy();
    session.sttProcessor?.destroy();

    // Flush STT usage tracking AFTER destroy (captures final speech durations)
    session.usageTracker?.flush();

    await releaseSessionEngine(session);

    // Kill ffmpeg resamplers for this session's participants only
    const participants = getSessionParticipants(session.id);
    for (const p of participants) {
      ffmpegRegistry.kill(p.user_id, session.id);
    }

    // Close all open speech bursts, then close audio streams
    session.burstTracker.destroy();
    session.recorder.closeAll();

    // Mark all participants as left
    for (const p of participants) {
      if (!p.left_at) {
        markParticipantLeft(session.id, p.user_id, now.toISOString());
      }
    }

    // Destroy voice connection (may already be destroyed)
    try {
      session.connection.destroy();
    } catch {
      // Already destroyed
    }

    // Update DB
    endSession(session.id, now.toISOString(), 'error');
    dbEnded = true;

    // Best-effort cleanup of Discord indicators
    try {
      const guild = await client.guilds.fetch(guildId);
      await restoreNickname(guild, session);
      await unpinStatusMessage(guild, session);
    } catch {
      logger.warn(`Force-end: could not clean up indicators for guild ${guildId}`);
    }

    // Notify the GM via channel message
    await notifyDisconnect(client, session);

    logger.info(`Session ${session.id} force-ended: ${reason}`);
  } finally {
    // Safety net: ensure DB is marked as ended even if teardown throws before endSession
    if (!dbEnded) {
      try { endSession(session.id, now.toISOString(), 'error'); } catch { /* DB may be closed */ }
    }
    // ALWAYS clean up runtime state — prevents "stuck guild" on teardown errors
    activeSessions.delete(guildId);
  }
}

async function notifyDisconnect(client: Client, session: ActiveSession): Promise<void> {
  // Try the channel where the status message was posted, then the first text channel
  const channelId = session.statusChannelId
    ?? (session.textChannelIds.length > 0 ? session.textChannelIds[0] : null);
  if (!channelId) return;

  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased() && 'send' in channel) {
      await (channel as TextChannel).send(
        `Recording session ended due to voice disconnect.\n` +
        `Reconnection failed after multiple attempts.\n` +
        `**Session ID:** \`${session.id}\`\n\n` +
        `> Raw audio files contain speech only. Run \`npm run hydrate-audio ${session.id}\` to generate listenable files.`
      );
    }
  } catch {
    logger.warn(`Could not notify about disconnect for session ${session.id}`);
  }
}
