import {
  REST,
  Routes,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { getConfig, requireClientId } from '../config';
import { logger } from '../logger';
import { sessionCommand } from './session';
import { consentCommand } from './consent';

export interface CommandModule {
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  // execute handler will be typed properly once we wire up interactions
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
