import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  type Interaction,
} from 'discord.js';
import { getConfig } from './config.js';
import { logger } from './logger.js';
import { registerCommands, getCommandMap } from './commands/index.js';
import { initDb, recoverStaleSessions, closeDb } from './db/index.js';
import { shutdownAllSessions } from './session-manager.js';
import { registerLateJoinHandler } from './voice/late-join.js';
import { registerTextMonitor } from './text/monitor.js';
import { startMonitoring, stopMonitoring } from './monitoring.js';

const config = getConfig();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// --- Interaction handler ---

const commandMap = getCommandMap();

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commandMap.get(interaction.commandName);
  if (!command) {
    logger.warn(`Unknown command: ${interaction.commandName}`);
    return;
  }

  logger.info(
    `Command: /${interaction.commandName} ${interaction.options.getSubcommand(false) ?? ''} by ${interaction.user.tag}`
  );

  await command.execute(interaction);
});

// --- Graceful shutdown ---

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal} -- starting graceful shutdown...`);

  try {
    await shutdownAllSessions(client);
    stopMonitoring();
    client.destroy();
    closeDb();
    logger.info('Discord client destroyed. Goodbye.');
  } catch (err) {
    logger.error('Error during shutdown:', err);
  }

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
  gracefulShutdown('uncaughtException');
});

// --- Startup ---

async function main(): Promise<void> {
  logger.info('Magi Assistant Discord starting...');
  logger.info(`  Data dir: ${config.dataDir}`);
  logger.info(`  DB path: ${config.dbPath}`);
  logger.info(`  Guilds configured: ${Object.keys(config.guilds).length}`);

  // Initialize database and run crash recovery BEFORE ready event
  initDb();
  recoverStaleSessions();

  await registerCommands();
  registerLateJoinHandler(client);
  registerTextMonitor(client);
  startMonitoring();

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(`Bot online as ${readyClient.user.tag}`);
  });

  await client.login(config.discordToken);
}

main().catch((err) => {
  logger.error('Fatal startup error:', err);
  process.exit(1);
});
