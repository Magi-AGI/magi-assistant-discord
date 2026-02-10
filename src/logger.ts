/**
 * Log sanitizer — strips Discord bot tokens and other secrets from all output.
 *
 * Discord bot tokens match: [\w-]{24}.[\w-]{6}.[\w-]{27,}
 * JS error objects from discord.js can dump Authorization headers — this catches those.
 */

const TOKEN_PATTERN = /[\w-]{24}\.[\w-]{6}\.[\w-]{27,}/g;
const AUTHORIZATION_HEADER_PATTERN = /(?<=Authorization:\s*(?:Bot\s+)?)\S+/gi;

function sanitize(message: string): string {
  return message
    .replace(TOKEN_PATTERN, '[REDACTED_TOKEN]')
    .replace(AUTHORIZATION_HEADER_PATTERN, '[REDACTED]');
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
      try {
        return sanitize(JSON.stringify(arg));
      } catch {
        return sanitize(String(arg));
      }
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
