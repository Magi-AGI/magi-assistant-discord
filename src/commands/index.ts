import {
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { getConfig, requireClientId } from '../config.js';
import { logger } from '../logger.js';
import { sessionCommand } from './session.js';
import { consentCommand } from './consent.js';

export interface CommandModule {
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

const commands: CommandModule[] = [sessionCommand, consentCommand];

export function getCommandMap(): Map<string, CommandModule> {
  const map = new Map<string, CommandModule>();
  for (const cmd of commands) {
    map.set(cmd.data.name, cmd);
  }
  return map;
}

export async function registerCommands(): Promise<void> {
  const config = getConfig();
  const clientId = requireClientId();
  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  const body = commands.map((c) => c.data);

  logger.info(`Registering ${body.length} slash commands...`);
  await rest.put(Routes.applicationCommands(clientId), { body });
  logger.info('Slash commands registered.');
}
