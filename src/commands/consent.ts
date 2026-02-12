import {
  type ChatInputCommandInteraction,
  type GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { logger } from '../logger.js';
import {
  upsertConsent,
  getConsent,
  isConsentRequired,
  upsertGuildSettings,
  getGuildSettings,
  insertParticipant,
} from '../db/queries.js';
import { getActiveSessionForGuild, teardownUserInSession } from '../session-manager.js';
import { forgetUser } from '../retention.js';
import { ffmpegRegistry } from '../stt/process-registry.js';
import { getConfig } from '../config.js';
import type { CommandModule } from './index.js';

export const consentCommand: CommandModule = {
  data: new SlashCommandBuilder()
    .setName('consent')
    .setDescription('Manage recording consent')
    .addSubcommand((sub) =>
      sub
        .setName('toggle')
        .setDescription('Toggle whether consent is required for this server (GM only)')
    )
    .addSubcommand((sub) =>
      sub.setName('accept').setDescription('Give your consent to be recorded')
    )
    .addSubcommand((sub) =>
      sub.setName('revoke').setDescription('Revoke your recording consent')
    )
    .addSubcommand((sub) =>
      sub.setName('forget').setDescription('Delete all your recorded data from this server')
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();

    try {
      switch (subcommand) {
        case 'toggle':
          await handleToggle(interaction);
          break;
        case 'accept':
          await handleAccept(interaction);
          break;
        case 'revoke':
          await handleRevoke(interaction);
          break;
        case 'forget':
          await handleForget(interaction);
          break;
        default:
          await interaction.reply({ content: `Unknown subcommand: ${subcommand}`, flags: MessageFlags.Ephemeral });
      }
    } catch (err) {
      logger.error(`Error handling /consent ${subcommand}:`, err);
      const msg = 'An error occurred while processing the command.';
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msg);
      } else {
        await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      }
    }
  },
};

async function handleToggle(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  // GM-only: check ManageGuild permission
  const member = interaction.member as GuildMember;
  if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: 'Only server managers can toggle consent requirements.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const currentlyRequired = isConsentRequired(guild.id);
  const newValue = !currentlyRequired;

  upsertGuildSettings(guild.id, { consentRequired: newValue });

  const status = newValue ? 'enabled' : 'disabled';
  await interaction.reply({
    content: `Consent requirement **${status}** for this server.\n` +
      (newValue
        ? 'Players must use `/consent accept` to be recorded.'
        : 'All users will be recorded without explicit consent.'),
    flags: MessageFlags.Ephemeral,
  });

  logger.info(`Consent toggled to ${status} in guild ${guild.id} by ${interaction.user.tag}`);
}

async function handleAccept(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  upsertConsent(guild.id, interaction.user.id, true);

  await interaction.reply({
    content: 'You have **accepted** recording consent for this server. Your audio and text will be captured during sessions.',
    flags: MessageFlags.Ephemeral,
  });

  logger.info(`Consent accepted by ${interaction.user.tag} in guild ${guild.id}`);

  // If a session is active, subscribe the user's audio and STT if they're in the voice channel
  const session = getActiveSessionForGuild(guild.id);
  if (session) {
    const member = await guild.members.fetch(interaction.user.id);
    if (member.voice.channelId === session.voiceChannelId) {
      const userId = interaction.user.id;

      const existingTrack = session.recorder.getTrack(userId);
      const config = getConfig();

      if (existingTrack) {
        // Audio track already exists — check if STT needs repair
        // (handles partial failure where audio was subscribed but STT wiring failed,
        //  or where resampler exists but gate was lost, or vice versa)
        const shouldWireStt = config.stt.enabled && session.sttProcessor &&
          (!session.diarized || userId === session.gmUserId);
        if (shouldWireStt) {
          const hasResampler = ffmpegRegistry.get(userId, session.id);
          const hasGate = session.sttProcessor!.hasUser(userId);
          if (!hasResampler || !hasGate) {
            // If gate exists but resampler is missing, gate holds a stale resampler
            // reference (VadGate binds to resampler at construction). Must rebuild both.
            if (hasGate) {
              session.sttProcessor!.removeUser(userId);
            }
            if (!hasResampler) {
              ffmpegRegistry.spawn(userId, session.id);
            }
            // (Re)create gate — now bound to current live resampler
            session.sttProcessor!.addUser(userId);
            if (session.transcriptWriter) {
              session.transcriptWriter.setUserTrackId(userId, existingTrack.trackId);
              if (session.diarized) {
                session.transcriptWriter.setUserTrackId(`diarized:${userId}`, existingTrack.trackId);
              }
            }
            logger.info(`Late consent: repaired STT wiring for ${interaction.user.tag} in session ${session.id}`);
          }
        }
        session.notifiedUsers.add(userId);
        return;
      }

      // Insert as a participant so session stop/force-end can iterate them
      insertParticipant({
        sessionId: session.id,
        userId,
        displayName: member.displayName,
        joinedAt: new Date().toISOString(),
      });

      session.recorder.subscribeUser(userId);
      logger.info(`Late consent: subscribed ${interaction.user.tag} to audio in session ${session.id}`);

      // Wire STT pipeline if enabled
      if (config.stt.enabled) {
        const shouldSetupStt = !session.diarized || userId === session.gmUserId;
        if (shouldSetupStt) {
          ffmpegRegistry.spawn(userId, session.id);
          session.sttProcessor?.addUser(userId);
        }

        // Register track and display name for transcript writer
        if (session.transcriptWriter) {
          const track = session.recorder.getTrack(userId);
          if (track) {
            session.transcriptWriter.setUserTrackId(userId, track.trackId);
            if (session.diarized && userId === session.gmUserId) {
              session.transcriptWriter.setUserTrackId(`diarized:${userId}`, track.trackId);
            }
          }
          session.transcriptWriter.setUserDisplayName(userId, member.displayName);
        }
        if (shouldSetupStt) {
          logger.info(`Late consent: wired STT for ${interaction.user.tag} in session ${session.id}`);
        }
      }

      // Add to notifiedUsers so they aren't re-processed by late-join handler
      session.notifiedUsers.add(userId);
    }
  }
}

async function handleRevoke(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  upsertConsent(guild.id, interaction.user.id, false);

  const consentRequired = isConsentRequired(guild.id);
  const replyText = consentRequired
    ? 'You have **revoked** recording consent for this server.\n' +
      'Your audio and text capture will stop immediately. Already-recorded data is retained.'
    : 'You have **revoked** recording consent for this server.\n' +
      'Note: consent gating is currently disabled for this server, so recording continues regardless. ' +
      'Your preference is saved and will take effect if consent gating is enabled.';

  await interaction.reply({
    content: replyText,
    flags: MessageFlags.Ephemeral,
  });

  logger.info(`Consent revoked by ${interaction.user.tag} in guild ${guild.id}`);

  // If a session is active and consent is required, stop recording this user immediately
  if (consentRequired) {
    const session = getActiveSessionForGuild(guild.id);
    if (session) {
      const userId = interaction.user.id;
      teardownUserInSession(session, userId);

      logger.info(`Consent revoke: stopped recording + STT for ${interaction.user.tag} in session ${session.id}`);
    }
  }
}

async function handleForget(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = forgetUser(guild.id, interaction.user.id);

  await interaction.editReply(
    `Your data has been deleted from this server.\n` +
    `- **Transcript segments deleted:** ${result.segmentsDeleted}\n` +
    `- **Audio tracks deleted:** ${result.tracksDeleted}\n` +
    `- **Sessions affected:** ${result.sessionsAffected}\n\n` +
    `Your consent record has also been removed.`
  );

  logger.info(`User ${interaction.user.tag} requested data deletion in guild ${guild.id}`);
}
