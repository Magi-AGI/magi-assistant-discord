import {
  type ChatInputCommandInteraction,
  type GuildMember,
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
} from '../db/queries.js';
import { getActiveSessionForGuild } from '../session-manager.js';
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
        default:
          await interaction.reply({ content: `Unknown subcommand: ${subcommand}`, ephemeral: true });
      }
    } catch (err) {
      logger.error(`Error handling /consent ${subcommand}:`, err);
      const reply = { content: 'An error occurred while processing the command.', ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(reply.content);
      } else {
        await interaction.reply(reply);
      }
    }
  },
};

async function handleToggle(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    return;
  }

  // GM-only: check ManageGuild permission
  const member = interaction.member as GuildMember;
  if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: 'Only server managers can toggle consent requirements.',
      ephemeral: true,
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
    ephemeral: true,
  });

  logger.info(`Consent toggled to ${status} in guild ${guild.id} by ${interaction.user.tag}`);
}

async function handleAccept(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    return;
  }

  upsertConsent(guild.id, interaction.user.id, true);

  await interaction.reply({
    content: 'You have **accepted** recording consent for this server. Your audio and text will be captured during sessions.',
    ephemeral: true,
  });

  logger.info(`Consent accepted by ${interaction.user.tag} in guild ${guild.id}`);

  // If a session is active, subscribe the user's audio if they're in the voice channel
  const session = getActiveSessionForGuild(guild.id);
  if (session) {
    const member = await guild.members.fetch(interaction.user.id);
    if (member.voice.channelId === session.voiceChannelId) {
      session.recorder.subscribeUser(interaction.user.id);
      logger.info(`Late consent: subscribed ${interaction.user.tag} to audio in session ${session.id}`);
    }
  }
}

async function handleRevoke(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
    return;
  }

  upsertConsent(guild.id, interaction.user.id, false);

  await interaction.reply({
    content: 'You have **revoked** recording consent for this server.\n' +
      'Your audio and text capture will stop going forward. Already-recorded data is retained.',
    ephemeral: true,
  });

  logger.info(`Consent revoked by ${interaction.user.tag} in guild ${guild.id}`);

  // If a session is active and consent is required, stop recording this user immediately
  if (isConsentRequired(guild.id)) {
    const session = getActiveSessionForGuild(guild.id);
    if (session) {
      session.burstTracker.closeUserBurst(interaction.user.id);
      session.recorder.closeUserTrack(interaction.user.id);
      logger.info(`Consent revoke: stopped recording ${interaction.user.tag} in session ${session.id}`);
    }
  }
}
