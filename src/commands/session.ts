import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
  type TextChannel,
} from 'discord.js';
import { logger } from '../logger.js';
import { startSession, stopSession, sessionStatus } from '../session-manager.js';
import { purgeSession } from '../retention.js';
import { getSession, insertSpeakerMapping, updateDisplayNameBySpeakerLabel } from '../db/queries.js';
import { getConfig } from '../config.js';
import type { CommandModule } from './index.js';

export const sessionCommand: CommandModule = {
  data: new SlashCommandBuilder()
    .setName('session')
    .setDescription('Manage recording sessions')
    .addSubcommand((sub) =>
      sub
        .setName('start')
        .setDescription('Start a recording session')
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Text channel to monitor (overrides config default)')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
        )
        .addBooleanOption((opt) =>
          opt
            .setName('diarized')
            .setDescription('Use diarized mode (single GM stream with speaker diarization)')
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub.setName('stop').setDescription('Stop the current recording session')
    )
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Show current session status')
    )
    .addSubcommand((sub) =>
      sub
        .setName('purge')
        .setDescription('Permanently delete a session and all its data (GM only)')
        .addStringOption((opt) =>
          opt
            .setName('session-id')
            .setDescription('Session ID to purge (for confirmation)')
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('map-speaker')
        .setDescription('Map a diarized speaker label to a player name')
        .addStringOption((opt) =>
          opt
            .setName('label')
            .setDescription('Speaker label (e.g., "speaker_1")')
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('name')
            .setDescription('Player name to assign')
            .setRequired(true)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();

    try {
      switch (subcommand) {
        case 'start': {
          const channelOption = interaction.options.getChannel('channel');
          const textChannel = channelOption as TextChannel | null;
          await startSession(interaction, textChannel);
          break;
        }
        case 'stop':
          await stopSession(interaction);
          break;
        case 'status':
          await sessionStatus(interaction);
          break;
        case 'purge':
          await handlePurge(interaction);
          break;
        case 'map-speaker':
          await handleMapSpeaker(interaction);
          break;
        default:
          await interaction.reply({ content: `Unknown subcommand: ${subcommand}`, flags: MessageFlags.Ephemeral });
      }
    } catch (err) {
      logger.error(`Error handling /session ${subcommand}:`, err);
      const msg = 'An error occurred while processing the command.';
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(msg);
      } else {
        await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      }
    }
  },
};

async function handlePurge(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const config = getConfig();
  if (!config.dataRetention.enablePurgeCommand) {
    await interaction.reply({
      content: 'The purge command is disabled. Set `dataRetention.enablePurgeCommand: true` in config.json to enable it.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = interaction.member as GuildMember;
  if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: 'Only server managers can purge sessions.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sessionId = interaction.options.getString('session-id', true);
  const session = getSession(sessionId);
  if (!session) {
    await interaction.reply({
      content: `Session not found: \`${sessionId}\``,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (session.guild_id !== guild.id) {
    await interaction.reply({
      content: 'That session does not belong to this server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (session.status === 'active') {
    await interaction.reply({
      content: 'Cannot purge an active session. Stop it first with `/session stop`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  purgeSession(sessionId);

  await interaction.reply({
    content: `Session \`${sessionId}\` and all associated data (audio, transcripts, text events) have been **permanently deleted**. This cannot be undone.`,
    flags: MessageFlags.Ephemeral,
  });

  logger.info(`Session ${sessionId} purged by ${interaction.user.tag} in guild ${guild.id}`);
}

async function handleMapSpeaker(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  // This needs an active diarized session
  const { getActiveSessionForGuild } = await import('../session-manager.js');
  const session = getActiveSessionForGuild(guild.id);
  if (!session) {
    await interaction.reply({
      content: 'No active recording session. Speaker mapping requires an active diarized session.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!session.diarized) {
    await interaction.reply({
      content: 'The current session is not in diarized mode. Speaker mapping is only available for diarized sessions.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const label = interaction.options.getString('label', true);
  const name = interaction.options.getString('name', true);

  insertSpeakerMapping({
    sessionId: session.id,
    speakerLabel: label,
    playerName: name,
    mappedBy: interaction.user.id,
  });

  const updated = updateDisplayNameBySpeakerLabel(session.id, label, name);

  // Also register in-memory so future segments for this speaker label get the display name
  session.transcriptWriter?.setSpeakerDisplayName(label, name);

  await interaction.reply({
    content: `Mapped speaker **${label}** → **${name}** (updated ${updated} existing transcript segments).`,
    flags: MessageFlags.Ephemeral,
  });

  logger.info(`Speaker mapping: ${label} → ${name} in session ${session.id} by ${interaction.user.tag}`);
}
