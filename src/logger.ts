/**
 * Log sanitizer — strips Discord bot tokens and other secrets from all output.
 *
 * Discord bot tokens match: [\w-]{24}.[\w-]{6}.[\w-]{27,}
 * JS error objects from discord.js can dump Authorization headers — this catches those.
 *
 * Uses util.inspect instead of JSON.stringify to safely handle circular references
 * (common in discord.js objects like Guild, Channel, Message).
 */

import { inspect } from 'util';

const TOKEN_PATTERN = /[\w-]{24}\.[\w-]{6}\.[\w-]{27,}/g;
const AUTHORIZATION_HEADER_PATTERN = /(?<=Authorization:\s*(?:Bot\s+)?)\S+/gi;

// Dynamic secret redaction (for MCP_AUTH_TOKEN, etc.)
const secretFragments: string[] = [];
let secretPattern: RegExp | null = null;

/** Register a secret value so it is redacted from all log output. */
export function registerSecret(secret: string): void {
  // Only redact strings long enough to be meaningful (avoid redacting common short words)
  if (secret && secret.length >= 8) {
    secretFragments.push(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    secretPattern = new RegExp(secretFragments.join('|'), 'g');
  }
}

function sanitize(message: string): string {
  let result = message
    .replace(TOKEN_PATTERN, '[REDACTED_TOKEN]')
    .replace(AUTHORIZATION_HEADER_PATTERN, '[REDACTED]');
  if (secretPattern) {
    result = result.replace(secretPattern, '[REDACTED]');
  }
  return result;
}

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) {
        const stack = arg.stack ?? arg.message;
        return sanitize(stack);
      }
      if (typeof arg === 'string') {
        return sanitize(arg);
      }
      // util.inspect handles circular references natively (outputs [Circular *N])
      // and produces useful output for discord.js objects, unlike String() which
      // gives "[object Object]"
      return sanitize(inspect(arg, { depth: 3, breakLength: Infinity }));
    })
    .join(' ');
}

function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  info(...args: unknown[]): void {
    console.log(`[${timestamp()}] [INFO]`, formatArgs(args));
  },
  warn(...args: unknown[]): void {
    console.warn(`[${timestamp()}] [WARN]`, formatArgs(args));
  },
  error(...args: unknown[]): void {
    console.error(`[${timestamp()}] [ERROR]`, formatArgs(args));
  },
  debug(...args: unknown[]): void {
    if (process.env.DEBUG) {
      console.debug(`[${timestamp()}] [DEBUG]`, formatArgs(args));
    }
  },
};
