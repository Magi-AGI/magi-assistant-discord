import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type TextChannel,
} from 'discord.js';
import { logger } from '../logger.js';
import { startSession, stopSession, sessionStatus } from '../session-manager.js';
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
    )
    .addSubcommand((sub) =>
      sub.setName('stop').setDescription('Stop the current recording session')
    )
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Show current session status')
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
        default:
          await interaction.reply({ content: `Unknown subcommand: ${subcommand}`, ephemeral: true });
      }
    } catch (err) {
      logger.error(`Error handling /session ${subcommand}:`, err);
      const reply = { content: 'An error occurred while processing the command.', ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(reply.content);
      } else {
        await interaction.reply(reply);
      }
    }
  },
};
