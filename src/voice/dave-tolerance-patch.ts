import { VoiceReceiver } from '@discordjs/voice';
import { logger } from '../logger.js';

/**
 * Workaround for upstream bug discordjs/discord.js#11419: when a single packet
 * triggers a `DecryptionFailed(UnencryptedWhenPassthroughDisabled)` (or similar
 * DAVE/parse error), `VoiceReceiver.onUdpMessage` calls `stream.destroy(error)`
 * which deletes the userId from the subscriptions map. Every subsequent UDP
 * packet for that user is then silently dropped at the `if (!stream) return`
 * guard. The bot rebinds, but the new subscription dies on the next decrypt
 * error within seconds — net result: ~14% audio capture and zero usable
 * transcripts (incident 2026-04-23, Group 2 Session 2).
 *
 * This monkey-patches `VoiceReceiver.prototype.onUdpMessage` to swallow DAVE
 * decrypt / parse errors instead of destroying the stream. The single offending
 * packet is dropped; the subscription stays alive; legitimate non-DAVE errors
 * still kill the subscription as before.
 *
 * Remove when @discordjs/voice ships a fix for #11419.
 */

let patched = false;

export function installDaveTolerancePatch(): void {
  if (patched) return;
  patched = true;

  const proto = VoiceReceiver.prototype as unknown as {
    onUdpMessage: (msg: Buffer) => void;
    parsePacket: (msg: Buffer, mode: string, nonce: Buffer, key: Buffer, userId: string) => Buffer;
    ssrcMap: Map<number, { userId: string }>;
    speaking: { onPacket: (userId: string) => void };
    subscriptions: Map<string, { push: (b: Buffer) => void; destroy: (e?: Error) => void }>;
    connectionData: { encryptionMode?: string; nonceBuffer?: Buffer; secretKey?: Uint8Array };
  };

  let lastWarn = 0;

  proto.onUdpMessage = function patchedOnUdpMessage(msg: Buffer) {
    if (msg.length <= 8) return;
    const ssrc = msg.readUInt32BE(8);
    const userData = this.ssrcMap.get(ssrc);
    if (!userData) return;
    this.speaking.onPacket(userData.userId);
    const stream = this.subscriptions.get(userData.userId);
    if (!stream) return;
    const cd = this.connectionData;
    if (!(cd.encryptionMode && cd.nonceBuffer && cd.secretKey)) return;
    try {
      const packet = this.parsePacket(
        msg,
        cd.encryptionMode,
        cd.nonceBuffer,
        cd.secretKey as unknown as Buffer,
        userData.userId,
      );
      if (packet) stream.push(packet);
    } catch (error) {
      const errMsg = (error as Error)?.message ?? String(error);
      const isDave =
        errMsg.includes('UnencryptedWhenPassthroughDisabled') ||
        errMsg.includes('DecryptionFailed') ||
        errMsg.includes('Failed to decrypt') ||
        errMsg.includes('Failed to parse packet');
      if (isDave) {
        const now = Date.now();
        if (now - lastWarn > 5000) {
          lastWarn = now;
          logger.warn(
            `[dave-tolerance] dropping undecryptable packet for ${userData.userId}: ${errMsg}`,
          );
        }
        return;
      }
      stream.destroy(error as Error);
    }
  };

  logger.info('[dave-tolerance] VoiceReceiver.onUdpMessage patched (workaround for discordjs/discord.js#11419)');
}
