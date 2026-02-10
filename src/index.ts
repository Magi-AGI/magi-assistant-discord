import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  type Interaction,
} from 'discord.js';
import { getConfig } from './config';
import { logger } from './logger';
import { registerCommands, getCommandMap } from './commands';

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

  // Command execute handlers will be wired in Step 4
  logger.info(
    `Command received: /${interaction.commandName} ${interaction.options.getSubcommand(false) ?? ''}`
  );
  await interaction.reply({
    content: 'Command received (handler not yet implemented).',
    ephemeral: true,
  });
});

// --- Graceful shutdown ---

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`Received ${signal} — starting graceful shutdown...`);

  try {
    // TODO (Step 4+): Stop active sessions, finalize audio files, close DB
    client.destroy();
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

  // TODO (Step 3): Initialize database, run crash recovery BEFORE ready

  await registerCommands();

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(`Bot online as ${readyClient.user.tag}`);
  });

  await client.login(config.discordToken);
}

main().catch((err) => {
  logger.error('Fatal startup error:', err);
  process.exit(1);
});
