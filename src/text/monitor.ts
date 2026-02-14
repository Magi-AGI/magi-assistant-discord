import {
  type Client,
  type Message,
  type PartialMessage,
  Events,
} from 'discord.js';
import { logger } from '../logger.js';
import { getActiveSessionForGuild } from '../session-manager.js';
import { insertTextEvent, isConsentRequired, getConsent } from '../db/queries.js';

// Populated at registration time so we can skip our own bot's messages
// while still capturing other bots (dice bots, game bots, etc.)
let selfUserId: string | null = null;

/**
 * Register text channel event listeners for message capture.
 * Captures create, edit, and delete events during active sessions.
 * Captures all users including other bots (dice rolls, game bots),
 * but skips this bot's own messages.
 */
export function registerTextMonitor(client: Client): void {
  client.once(Events.ClientReady, (readyClient) => {
    selfUserId = readyClient.user.id;
  });

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

/**
 * Check if this channel is being monitored in an active session.
 * Returns the session ID if monitored, null otherwise.
 * If no text channels are configured, captures nothing (explicit config required).
 */
function isMonitoredChannel(guildId: string, channelId: string): string | null {
  const session = getActiveSessionForGuild(guildId);
  if (!session) return null;
  if (session.textChannelIds.length === 0) return null;
  if (session.textChannelIds.includes(channelId)) return session.id;
  return null;
}

function epochToIso(epochMs: number | null | undefined): string | null {
  if (!epochMs) return null;
  return new Date(epochMs).toISOString();
}

/** Build content string including attachment URLs. */
function buildContent(message: Message | PartialMessage): string | null {
  const text = message.content ?? '';
  const attachmentUrls: string[] = [];

  if ('attachments' in message && message.attachments?.size) {
    for (const [, attachment] of message.attachments) {
      attachmentUrls.push(attachment.url);
    }
  }

  if (!text && attachmentUrls.length === 0) return null;

  if (attachmentUrls.length === 0) return text || null;
  const suffix = '\n[Attachments: ' + attachmentUrls.join(', ') + ']';
  return (text + suffix).trim() || null;
}

function isSelf(authorId: string | undefined | null): boolean {
  return !!selfUserId && authorId === selfUserId;
}

function handleMessageCreate(message: Message): void {
  if (!message.guild) return;
  if (isSelf(message.author?.id)) return;

  const sessionId = isMonitoredChannel(message.guild.id, message.channelId);
  if (!sessionId) return;

  // Consent gate: skip if user hasn't consented and consent is required
  if (message.author && isConsentRequired(message.guild.id)) {
    const consent = getConsent(message.guild.id, message.author.id);
    if (!consent || consent.consented !== 1) return;
  }

  insertTextEvent({
    sessionId,
    messageId: message.id,
    userId: message.author.id,
    channelId: message.channelId,
    messageTimestamp: epochToIso(message.createdTimestamp),
    eventReceivedAt: new Date().toISOString(),
    content: buildContent(message),
    eventType: 'create',
  });

  logger.debug(`Text event [create]: message ${message.id} by ${message.author.tag}`);
}

function handleMessageUpdate(message: Message | PartialMessage): void {
  if (!message.guild) return;
  if (isSelf(message.author?.id)) return;

  const sessionId = isMonitoredChannel(message.guild.id, message.channelId);
  if (!sessionId) return;

  // Consent gate
  if (message.author && isConsentRequired(message.guild.id)) {
    const consent = getConsent(message.guild.id, message.author.id);
    if (!consent || consent.consented !== 1) return;
  }

  const userId = message.author?.id ?? null;
  const editedTimestamp = message.editedTimestamp
    ? epochToIso(message.editedTimestamp)
    : null;

  insertTextEvent({
    sessionId,
    messageId: message.id,
    userId,
    channelId: message.channelId,
    messageTimestamp: editedTimestamp,
    eventReceivedAt: new Date().toISOString(),
    content: buildContent(message),
    eventType: 'edit',
  });

  logger.debug(`Text event [edit]: message ${message.id}`);
}

function handleMessageDelete(message: Message | PartialMessage): void {
  if (!message.guild) return;
  if (isSelf(message.author?.id)) return;

  const sessionId = isMonitoredChannel(message.guild.id, message.channelId);
  if (!sessionId) return;

  const consentRequired = isConsentRequired(message.guild.id);

  // Consent gate: if author is known, check consent.
  // If author is unknown (uncached partial) and consent is required,
  // store metadata-only (no content) to avoid capturing non-consented data.
  if (message.author && consentRequired) {
    const consent = getConsent(message.guild.id, message.author.id);
    if (!consent || consent.consented !== 1) return;
  }

  const userId = message.author?.id ?? null;
  // When consent is required and author is unknown, omit content (metadata-only)
  const content = (consentRequired && !message.author) ? null : (message.content ?? null);

  insertTextEvent({
    sessionId,
    messageId: message.id,
    userId,
    channelId: message.channelId,
    messageTimestamp: null,
    eventReceivedAt: new Date().toISOString(),
    content,
    eventType: 'delete',
  });

  logger.debug(`Text event [delete]: message ${message.id}`);
}
