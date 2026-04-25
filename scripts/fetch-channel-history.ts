#!/usr/bin/env tsx
/**
 * Fetch full Discord channel message history into the local SQLite archive.
 *
 * Usage:
 *   npm run fetch-history -- [options]
 *
 * Options:
 *   --guild <id>              Guild ID (default: first guild in config.json)
 *   --channels <id,id,...>    Specific channel IDs to fetch
 *   --list                    List all text channels in the guild and exit
 *   --status                  Show fetch progress for all tracked channels
 *   --update-only             Only fetch new messages (skip backward fill)
 *   --import-dms <path>       Import DMs from Discord data export directory
 *
 * The script is safe to interrupt (Ctrl+C) and resume — progress is saved
 * after each batch of 100 messages. Duplicate messages are silently skipped.
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import {
  Client,
  GatewayIntentBits,
  ChannelType,
  type TextChannel,
  type Message,
  type Collection,
  type Snowflake,
} from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import { initDb } from '../src/db/index.js';
import { getConfig } from '../src/config.js';
import {
  insertChannelMessageBatch,
  getChannelFetchProgress,
  getAllChannelFetchProgress,
  upsertChannelFetchProgress,
  getChannelMessageCount,
  type ChannelFetchProgressRow,
} from '../src/db/queries.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BATCH_SIZE = 100; // Discord API max per request
const BATCH_DELAY_MS = 300; // Politeness delay between fetches

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Convert a Discord.js Message to the shape insertChannelMessageBatch expects. */
function messageToRow(msg: Message, channelName: string | null) {
  const attachments = msg.attachments.size > 0
    ? JSON.stringify(msg.attachments.map((a) => ({ id: a.id, url: a.url, name: a.name, size: a.size })))
    : null;

  const embeds = msg.embeds.length > 0
    ? JSON.stringify(msg.embeds.map((e) => ({
        title: e.title, description: e.description, url: e.url, type: e.data?.type,
      })))
    : null;

  return {
    messageId: msg.id,
    channelId: msg.channelId,
    channelName,
    guildId: msg.guildId,
    authorId: msg.author.id,
    authorName: msg.author.displayName ?? msg.author.username,
    content: msg.content || null,
    timestamp: msg.createdAt.toISOString(),
    editedTimestamp: msg.editedAt?.toISOString() ?? null,
    attachments,
    embeds,
    replyToId: msg.reference?.messageId ?? null,
    isBot: msg.author.bot,
    isPinned: msg.pinned,
    source: 'api' as const,
  };
}

/** Pretty-print a date from a Discord snowflake or ISO string. */
function fmtDate(isoOrSnowflake: string | Date): string {
  const d = isoOrSnowflake instanceof Date ? isoOrSnowflake : new Date(isoOrSnowflake);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

// ---------------------------------------------------------------------------
// Core fetch logic
// ---------------------------------------------------------------------------

interface FetchResult {
  fetched: number;
  inserted: number;
  alreadyHad: number;
}

/**
 * Fetch messages backward (older) from a starting point.
 * If beforeId is null, starts from the channel's latest message.
 */
async function fetchBackward(
  channel: TextChannel,
  progress: ChannelFetchProgressRow | undefined,
  signal: AbortSignal,
): Promise<FetchResult> {
  let beforeId: string | undefined = progress?.oldest_fetched_id ?? undefined;
  let newestId = progress?.newest_fetched_id ?? undefined;
  let totalCount = progress?.message_count ?? 0;
  let fetched = 0;
  let inserted = 0;

  console.log(`  [backward] ${channel.name}: starting${beforeId ? ` from ${beforeId}` : ' from latest'}...`);

  while (!signal.aborted) {
    const options: { limit: number; before?: Snowflake } = { limit: BATCH_SIZE };
    if (beforeId) options.before = beforeId;

    let messages: Collection<string, Message>;
    try {
      messages = await channel.messages.fetch(options);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [backward] ${channel.name}: fetch error: ${msg}`);
      break;
    }

    if (messages.size === 0) {
      // Reached the beginning of the channel
      upsertChannelFetchProgress({
        channelId: channel.id,
        guildId: channel.guildId,
        channelName: channel.name,
        oldestFetchedId: beforeId ?? null,
        newestFetchedId: newestId ?? null,
        messageCount: totalCount,
        isComplete: true,
      });
      console.log(`  [backward] ${channel.name}: reached beginning of history.`);
      break;
    }

    // messages Collection is sorted newest-first
    const sorted = [...messages.values()];
    const batchNewest = sorted[0];
    const batchOldest = sorted[sorted.length - 1];

    if (!newestId) newestId = batchNewest.id;

    // Insert batch
    const rows = sorted.map((m) => messageToRow(m, channel.name));
    const batchInserted = insertChannelMessageBatch(rows);

    fetched += sorted.length;
    inserted += batchInserted;
    totalCount += batchInserted;
    beforeId = batchOldest.id;

    // Save progress
    upsertChannelFetchProgress({
      channelId: channel.id,
      guildId: channel.guildId,
      channelName: channel.name,
      oldestFetchedId: beforeId,
      newestFetchedId: newestId,
      messageCount: totalCount,
      isComplete: false,
    });

    console.log(
      `  [backward] ${channel.name}: ${fetched} fetched, ${inserted} new ` +
      `(reached ${fmtDate(batchOldest.createdAt)})`,
    );

    if (messages.size < BATCH_SIZE) {
      // Last page — less than full batch means we hit the beginning
      upsertChannelFetchProgress({
        channelId: channel.id,
        guildId: channel.guildId,
        channelName: channel.name,
        oldestFetchedId: beforeId,
        newestFetchedId: newestId,
        messageCount: totalCount,
        isComplete: true,
      });
      console.log(`  [backward] ${channel.name}: reached beginning of history.`);
      break;
    }

    await sleep(BATCH_DELAY_MS);
  }

  return { fetched, inserted, alreadyHad: fetched - inserted };
}

/**
 * Fetch messages forward (newer) from the last known newest message.
 */
async function fetchForward(
  channel: TextChannel,
  progress: ChannelFetchProgressRow,
  signal: AbortSignal,
): Promise<FetchResult> {
  let afterId: string = progress.newest_fetched_id!;
  let totalCount = progress.message_count;
  let fetched = 0;
  let inserted = 0;

  console.log(`  [forward] ${channel.name}: checking for new messages after ${afterId}...`);

  while (!signal.aborted) {
    let messages: Collection<string, Message>;
    try {
      messages = await channel.messages.fetch({ limit: BATCH_SIZE, after: afterId });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [forward] ${channel.name}: fetch error: ${msg}`);
      break;
    }

    if (messages.size === 0) break;

    // With `after`, Discord returns messages ascending by ID, but discord.js
    // Collection is sorted newest-first. Sort ascending for consistent processing.
    const sorted = [...messages.values()].sort(
      (a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1,
    );
    const batchNewest = sorted[sorted.length - 1];

    const rows = sorted.map((m) => messageToRow(m, channel.name));
    const batchInserted = insertChannelMessageBatch(rows);

    fetched += sorted.length;
    inserted += batchInserted;
    totalCount += batchInserted;
    afterId = batchNewest.id;

    // Save progress
    upsertChannelFetchProgress({
      channelId: channel.id,
      guildId: channel.guildId,
      channelName: channel.name,
      oldestFetchedId: progress.oldest_fetched_id,
      newestFetchedId: afterId,
      messageCount: totalCount,
      isComplete: progress.is_complete === 1,
    });

    if (fetched > 0) {
      console.log(
        `  [forward] ${channel.name}: ${fetched} fetched, ${inserted} new ` +
        `(up to ${fmtDate(batchNewest.createdAt)})`,
      );
    }

    if (messages.size < BATCH_SIZE) break;

    await sleep(BATCH_DELAY_MS);
  }

  if (fetched === 0) {
    console.log(`  [forward] ${channel.name}: already up to date.`);
  }

  return { fetched, inserted, alreadyHad: fetched - inserted };
}

/**
 * Archive a single channel: backward fill (if needed) then forward catch-up.
 */
async function archiveChannel(
  channel: TextChannel,
  updateOnly: boolean,
  signal: AbortSignal,
): Promise<FetchResult> {
  const progress = getChannelFetchProgress(channel.id);
  let totalFetched = 0;
  let totalInserted = 0;

  // Backward fill
  if (!updateOnly && (!progress || progress.is_complete === 0)) {
    const result = await fetchBackward(channel, progress, signal);
    totalFetched += result.fetched;
    totalInserted += result.inserted;
  }

  // Forward catch-up (only if we have a newest_fetched_id to start from)
  const current = getChannelFetchProgress(channel.id);
  if (current?.newest_fetched_id) {
    const result = await fetchForward(channel, current, signal);
    totalFetched += result.fetched;
    totalInserted += result.inserted;
  }

  return { fetched: totalFetched, inserted: totalInserted, alreadyHad: totalFetched - totalInserted };
}

// ---------------------------------------------------------------------------
// DM Import from Discord data export
// ---------------------------------------------------------------------------

interface ExportMessage {
  ID: string;
  Timestamp: string;
  Contents: string;
  Attachments: string;
}

interface ExportChannelIndex {
  [folderId: string]: string | { name?: string; recipients?: string[] } | null;
}

async function importDms(exportPath: string): Promise<void> {
  const messagesDir = path.join(exportPath, 'messages');
  if (!fs.existsSync(messagesDir)) {
    console.error(`No messages/ directory found in ${exportPath}`);
    console.error('Expected Discord data export structure: package/messages/index.json + c<id>/ folders');
    process.exit(1);
  }

  // Load channel index
  const indexPath = path.join(messagesDir, 'index.json');
  let channelIndex: ExportChannelIndex = {};
  if (fs.existsSync(indexPath)) {
    channelIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  }

  // Find all channel folders
  const entries = fs.readdirSync(messagesDir, { withFileTypes: true });
  const channelFolders = entries.filter((e) => e.isDirectory() && e.name.startsWith('c'));

  console.log(`Found ${channelFolders.length} channel folders in export.`);
  let grandTotal = 0;

  for (const folder of channelFolders) {
    const channelId = folder.name.replace(/^c/, '');
    const channelDir = path.join(messagesDir, folder.name);
    const channelInfo = channelIndex[folder.name];
    const channelName = typeof channelInfo === 'string'
      ? channelInfo
      : channelInfo?.name ?? `DM-${channelId}`;

    // Read channel.json for metadata if available
    let channelMeta: { id?: string; type?: number; name?: string; recipients?: string[] } = {};
    const metaPath = path.join(channelDir, 'channel.json');
    if (fs.existsSync(metaPath)) {
      channelMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    }

    // Find message CSV files
    const csvFiles = fs.readdirSync(channelDir)
      .filter((f) => f.startsWith('messages') && f.endsWith('.csv'))
      .sort();

    if (csvFiles.length === 0) {
      console.log(`  ${channelName}: no message files, skipping.`);
      continue;
    }

    let channelTotal = 0;
    for (const csvFile of csvFiles) {
      const csvPath = path.join(channelDir, csvFile);
      const rows = parseCsv(fs.readFileSync(csvPath, 'utf-8'));

      const batch = rows.map((row) => ({
        messageId: row.ID,
        channelId: channelMeta.id ?? channelId,
        channelName,
        guildId: null,
        authorId: '', // CSV export doesn't include author IDs
        authorName: '', // We'll fill these from channel.json recipients if possible
        content: row.Contents || null,
        timestamp: new Date(row.Timestamp).toISOString(),
        editedTimestamp: null,
        attachments: row.Attachments || null,
        embeds: null,
        replyToId: null,
        isBot: false,
        isPinned: false,
        source: 'export' as const,
      }));

      const inserted = insertChannelMessageBatch(batch);
      channelTotal += inserted;
    }

    if (channelTotal > 0) {
      console.log(`  ${channelName}: imported ${channelTotal} messages.`);
    }
    grandTotal += channelTotal;
  }

  console.log(`\nDM import complete: ${grandTotal} messages imported.`);
}

/** Minimal CSV parser for Discord export format (ID,Timestamp,Contents,Attachments). */
function parseCsv(text: string): ExportMessage[] {
  const lines = text.split('\n');
  if (lines.length < 2) return [];

  // First line is header
  const results: ExportMessage[] = [];
  let i = 1;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }

    // Handle quoted fields that may span multiple lines
    const fields = parseCSVLine(lines, i);
    if (fields.values.length >= 3) {
      results.push({
        ID: fields.values[0],
        Timestamp: fields.values[1],
        Contents: fields.values[2],
        Attachments: fields.values[3] ?? '',
      });
    }
    i = fields.nextLine;
  }
  return results;
}

function parseCSVLine(lines: string[], startLine: number): { values: string[]; nextLine: number } {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;
  let lineIdx = startLine;

  while (lineIdx < lines.length) {
    const line = lines[lineIdx];
    const chars = lineIdx === startLine ? line : '\n' + line;

    for (let j = 0; j < chars.length; j++) {
      const ch = chars[j];
      if (inQuotes) {
        if (ch === '"') {
          if (j + 1 < chars.length && chars[j + 1] === '"') {
            current += '"';
            j++;
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          values.push(current);
          current = '';
        } else {
          current += ch;
        }
      }
    }

    if (!inQuotes) {
      values.push(current);
      return { values, nextLine: lineIdx + 1 };
    }
    lineIdx++;
  }

  // EOF while in quotes — push what we have
  values.push(current);
  return { values, nextLine: lineIdx };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(): never {
  console.log(`Usage: npm run fetch-history -- [options]

Options:
  --guild <id>              Guild ID (default: first guild in config.json)
  --channels <id,id,...>    Specific channel IDs to fetch
  --list                    List all text channels in the guild and exit
  --status                  Show fetch progress for all tracked channels
  --update-only             Only fetch new messages (skip backward fill)
  --import-dms <path>       Import DMs from Discord data export directory`);
  process.exit(1);
}

function parseArgs(): {
  guildId?: string;
  channelIds?: string[];
  list: boolean;
  status: boolean;
  updateOnly: boolean;
  importDmsPath?: string;
} {
  const args = process.argv.slice(2);
  const result = { list: false, status: false, updateOnly: false } as ReturnType<typeof parseArgs>;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--guild':
        result.guildId = args[++i];
        break;
      case '--channels':
        result.channelIds = args[++i]?.split(',').map((s) => s.trim());
        break;
      case '--list':
        result.list = true;
        break;
      case '--status':
        result.status = true;
        break;
      case '--update-only':
        result.updateOnly = true;
        break;
      case '--import-dms':
        result.importDmsPath = args[++i];
        break;
      case '--help':
      case '-h':
        usage();
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        usage();
    }
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const config = getConfig();
  initDb();

  // --status: show progress table and exit (no Discord connection needed)
  if (args.status) {
    const allProgress = getAllChannelFetchProgress();
    if (allProgress.length === 0) {
      console.log('No channels have been fetched yet.');
      return;
    }
    console.log('Channel fetch progress:');
    console.log('─'.repeat(100));
    for (const p of allProgress) {
      const dbCount = getChannelMessageCount(p.channel_id);
      const status = p.is_complete ? 'complete' : 'partial';
      console.log(
        `  ${p.channel_name ?? p.channel_id} (${p.channel_id}): ` +
        `${dbCount} messages [${status}] — last fetched ${fmtDate(p.last_fetched_at)}`,
      );
    }
    return;
  }

  // --import-dms: import from Discord data export (no Discord connection needed)
  if (args.importDmsPath) {
    await importDms(args.importDmsPath);
    return;
  }

  // For all other modes we need a Discord connection
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error('Missing DISCORD_TOKEN environment variable.');
    process.exit(1);
  }

  const guildId = args.guildId ?? Object.keys(config.guilds)[0];
  if (!guildId) {
    console.error('No guild ID provided and none found in config.json.');
    process.exit(1);
  }

  console.log('Connecting to Discord...');
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  // Graceful shutdown
  const abortController = new AbortController();
  const shutdown = () => {
    console.log('\nShutting down gracefully (progress saved)...');
    abortController.abort();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await client.login(token);
    console.log(`Logged in as ${client.user?.tag}`);

    const guild = await client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    const textChannels = channels.filter(
      (ch): ch is TextChannel =>
        ch !== null && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement),
    );

    // --list: show channels and exit
    if (args.list) {
      console.log(`\nText channels in ${guild.name} (${guild.id}):`);
      console.log('─'.repeat(70));
      for (const [id, ch] of textChannels.sort((a, b) => a.position - b.position)) {
        const progress = getChannelFetchProgress(id);
        const status = progress
          ? `${progress.message_count} msgs, ${progress.is_complete ? 'complete' : 'partial'}`
          : 'not fetched';
        const category = ch.parent?.name ?? '(no category)';
        console.log(`  ${category} / #${ch.name}  ${id}  [${status}]`);
      }
      return;
    }

    // Resolve target channels
    let targets: TextChannel[];
    if (args.channelIds) {
      targets = args.channelIds
        .map((id) => textChannels.get(id))
        .filter((ch): ch is TextChannel => ch !== undefined);

      const missing = args.channelIds.filter((id) => !textChannels.has(id));
      if (missing.length > 0) {
        console.warn(`Warning: channel(s) not found: ${missing.join(', ')}`);
      }
    } else {
      targets = [...textChannels.values()].sort((a, b) => a.position - b.position);
    }

    if (targets.length === 0) {
      console.error('No text channels to fetch. Use --list to see available channels.');
      return;
    }

    console.log(`\nArchiving ${targets.length} channel(s) in ${guild.name}:`);
    const summary: { name: string; fetched: number; inserted: number }[] = [];

    for (const channel of targets) {
      if (abortController.signal.aborted) break;

      console.log(`\n[${ targets.indexOf(channel) + 1}/${targets.length}] #${channel.name} (${channel.id})`);
      const result = await archiveChannel(channel, args.updateOnly, abortController.signal);
      summary.push({ name: channel.name, ...result });
    }

    // Print summary
    console.log('\n' + '═'.repeat(60));
    console.log('SUMMARY');
    console.log('═'.repeat(60));
    for (const s of summary) {
      const dbCount = getChannelMessageCount(
        targets.find((t) => t.name === s.name)?.id ?? '',
      );
      console.log(`  #${s.name}: ${s.inserted} new, ${s.alreadyHad ?? 0} skipped (${dbCount} total in DB)`);
    }
  } finally {
    client.destroy();
    console.log('Disconnected.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
