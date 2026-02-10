import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
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
};
