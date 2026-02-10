import {
  type Client,
  type Message,
  type PartialMessage,
  Events,
} from 'discord.js';
import { logger } from '../logger.js';
import { getActiveSessionForGuild } from '../session-manager.js';
import { insertTextEvent } from '../db/queries.js';

/**
 * Register text channel event listeners for message capture.
 * Captures create, edit, and delete events during active sessions.
 */
export function registerTextMonitor(client: Client): void {
  client.on(Events.MessageCreate, (message: Message) => {
    handleMessageCreate(message);
  });

  client.on(Events.MessageUpdate, (_oldMessage: Message | PartialMessage, newMessage: Message | PartialMessage) => {
    handleMessageUpdate(newMessage);
  });

  client.on(Events.MessageDelete, (message: Message | PartialMessage) => {
    handleMessageDelete(message);
  });
}

function isMonitoredChannel(guildId: string, channelId: string): string | null {
  const session = getActiveSessionForGuild(guildId);
  if (!session) return null;
  if (session.textChannelIds.length === 0) return session.id; // Monitor all if none configured
  if (session.textChannelIds.includes(channelId)) return session.id;
  return null;
}

function epochToIso(epochMs: number | null | undefined): string | null {
  if (!epochMs) return null;
  return new Date(epochMs).toISOString();
}

function handleMessageCreate(message: Message): void {
  if (!message.guild) return;
  if (message.author.bot) return;

  const sessionId = isMonitoredChannel(message.guild.id, message.channelId);
  if (!sessionId) return;

  insertTextEvent({
    sessionId,
    messageId: message.id,
    userId: message.author.id,
    channelId: message.channelId,
    messageTimestamp: epochToIso(message.createdTimestamp),
    eventReceivedAt: new Date().toISOString(),
    content: message.content,
    eventType: 'create',
  });

  logger.debug(`Text event [create]: message ${message.id} by ${message.author.tag}`);
}

function handleMessageUpdate(message: Message | PartialMessage): void {
  if (!message.guild) return;

  const sessionId = isMonitoredChannel(message.guild.id, message.channelId);
  if (!sessionId) return;

  // For partials, some fields may be unavailable
  const userId = message.author?.id ?? null;
  const content = message.content ?? null;
  const editedTimestamp = message.editedTimestamp
    ? epochToIso(message.editedTimestamp)
    : null;

  // Skip bot edits
  if (message.author?.bot) return;

  insertTextEvent({
    sessionId,
    messageId: message.id,
    userId,
    channelId: message.channelId,
    messageTimestamp: editedTimestamp,
    eventReceivedAt: new Date().toISOString(),
    content,
    eventType: 'edit',
  });

  logger.debug(`Text event [edit]: message ${message.id}`);
}

function handleMessageDelete(message: Message | PartialMessage): void {
  if (!message.guild) return;

  const sessionId = isMonitoredChannel(message.guild.id, message.channelId);
  if (!sessionId) return;

  // For partials, content and author may be unavailable
  const userId = message.author?.id ?? null;
  const content = message.content ?? null;

  insertTextEvent({
    sessionId,
    messageId: message.id,
    userId,
    channelId: message.channelId,
    messageTimestamp: null, // Discord doesn't provide a deletion timestamp
    eventReceivedAt: new Date().toISOString(),
    content,
    eventType: 'delete',
  });

  logger.debug(`Text event [delete]: message ${message.id}`);
}
