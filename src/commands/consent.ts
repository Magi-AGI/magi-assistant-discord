import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { logger } from '../logger.js';
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
    // Consent handlers will be implemented in Step 9
    const subcommand = interaction.options.getSubcommand();
    logger.info(`/consent ${subcommand} invoked by ${interaction.user.tag}`);
    await interaction.reply({
      content: 'Consent commands will be available soon (Step 9).',
      ephemeral: true,
    });
  },
};
