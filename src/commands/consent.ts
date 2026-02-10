import { SlashCommandBuilder } from 'discord.js';
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
};
