/**
 * /yes and /no commands for GM image confirmation.
 *
 * These are ephemeral responses — they acknowledge the command.
 * They also insert a synthetic text event into the session DB
 * so the GM assistant can detect the confirmation via polling.
 *
 * Restricted to:
 *  - Users with the configured GM role (if gmRoleId is set)
 *  - Channels that are part of the active session's monitored text channels
 */

import {
  type ChatInputCommandInteraction,
  type GuildMemberRoleManager,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type { CommandModule } from './index.js';
import { getConfig } from '../config.js';
import { getActiveSessionForGuild } from '../session-manager.js';
import { insertTextEvent } from '../db/queries.js';
import { logger } from '../logger.js';

/**
 * Validate that the interaction is from a GM in a monitored session text channel.
 * Returns { ok: true, sessionId } on success, { ok: false, reason } on failure.
 */
function validateInteraction(interaction: ChatInputCommandInteraction): { ok: true; sessionId: string } | { ok: false; reason: string } {
  if (!interaction.guildId) {
    return { ok: false, reason: 'This command can only be used in a server.' };
  }

  const session = getActiveSessionForGuild(interaction.guildId);
  if (!session) {
    return { ok: false, reason: 'No active recording session in this server.' };
  }

  // Check GM role (if configured)
  const config = getConfig();
  const guildConfig = config.guilds[interaction.guildId];
  if (guildConfig?.gmRoleId) {
    const roles = interaction.member?.roles;
    const hasGmRole = roles instanceof Array
      ? roles.includes(guildConfig.gmRoleId)
      : (roles as GuildMemberRoleManager)?.cache?.has(guildConfig.gmRoleId) ?? false;
    if (!hasGmRole) {
      return { ok: false, reason: 'Only the GM can confirm or reject image suggestions.' };
    }
  }

  // Check channel is part of the session's monitored text channels
  if (session.textChannelIds.length > 0 && !session.textChannelIds.includes(interaction.channelId)) {
    return { ok: false, reason: 'This command must be used in a session-monitored text channel.' };
  }

  return { ok: true, sessionId: session.id };
}

/**
 * Write a synthetic text event so the GM assistant can detect
 * slash command interactions via text-event polling.
 */
function recordInteractionAsTextEvent(
  interaction: ChatInputCommandInteraction,
  sessionId: string,
  content: string,
): void {
  insertTextEvent({
    sessionId,
    messageId: interaction.id,
    userId: interaction.user.id,
    channelId: interaction.channelId,
    messageTimestamp: new Date(interaction.createdTimestamp).toISOString(),
    eventReceivedAt: new Date().toISOString(),
    content,
    eventType: 'create',
  });

  logger.debug(`Recorded ${content} interaction as text event for session ${sessionId}`);
}

export const yesCommand: CommandModule = {
  data: new SlashCommandBuilder()
    .setName('yes')
    .setDescription('Confirm the pending image suggestion from the GM assistant')
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const check = validateInteraction(interaction);
    if (!check.ok) {
      await interaction.reply({ content: check.reason, flags: MessageFlags.Ephemeral });
      return;
    }
    recordInteractionAsTextEvent(interaction, check.sessionId, '/yes');
    await interaction.reply({
      content: 'Image confirmed.',
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const noCommand: CommandModule = {
  data: new SlashCommandBuilder()
    .setName('no')
    .setDescription('Reject the pending image suggestion from the GM assistant')
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const check = validateInteraction(interaction);
    if (!check.ok) {
      await interaction.reply({ content: check.reason, flags: MessageFlags.Ephemeral });
      return;
    }
    recordInteractionAsTextEvent(interaction, check.sessionId, '/no');
    await interaction.reply({
      content: 'Image rejected.',
      flags: MessageFlags.Ephemeral,
    });
  },
};
