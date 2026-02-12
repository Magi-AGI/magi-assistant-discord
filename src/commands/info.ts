import {
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type { CommandModule } from './index.js';

export const infoCommand: CommandModule = {
  data: new SlashCommandBuilder()
    .setName('info')
    .setDescription('Show bot information and data handling summary')
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('Magi Assistant Discord')
      .setDescription('Recording bot for tabletop RPG sessions — captures per-user audio and text for AI GM training data.')
      .addFields(
        { name: 'Version', value: '0.1.0', inline: true },
        { name: 'Library', value: 'discord.js v14', inline: true },
        { name: 'Creator', value: 'Magi AGI', inline: true },
        { name: 'Source', value: '[GitHub](https://github.com/Magi-AGI/magi-assistant-discord)', inline: true },
      )
      .addFields({
        name: 'Data Handling',
        value:
          '- Per-user audio recorded as Opus/OGG during active sessions\n' +
          '- Text messages in monitored channels captured during sessions\n' +
          '- Speech-to-text transcription (when enabled)\n' +
          '- Data stored locally on the server\n' +
          '- Use `/consent` to manage your recording consent\n' +
          '- Use `/consent forget` to request deletion of your data',
      })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
