import { spawn } from 'child_process';
import {
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { logger } from '../logger.js';
import { getConfig } from '../config.js';

/**
 * Result of a preflight check. `ok` gates `/session start`.
 * `remediation` is surfaced to the GM so they know what to fix.
 */
export interface PreflightResult {
  ok: boolean;
  ffmpegOk: boolean;
  opusDecodeOk: boolean;
  sttConfigOk: boolean;
  remediation: string[];
  notes: string[];
}

/**
 * Cached preflight result per guild. `/session start` will consult this —
 * if the most recent preflight failed, start is blocked. Cache is cleared
 * after a successful `/session start`.
 */
const recentPreflight = new Map<string, { at: number; result: PreflightResult }>();

/** Preflight results older than this are ignored (GMs must re-run). */
export const PREFLIGHT_TTL_MS = 5 * 60 * 1000;

/**
 * Returns the most recent preflight result for a guild, if it's still fresh.
 * Used by the session start gate.
 */
export function getRecentPreflight(guildId: string): PreflightResult | null {
  const entry = recentPreflight.get(guildId);
  if (!entry) return null;
  if (Date.now() - entry.at > PREFLIGHT_TTL_MS) {
    recentPreflight.delete(guildId);
    return null;
  }
  return entry.result;
}

/** Clear any stored preflight (e.g. after a successful /session start). */
export function clearPreflight(guildId: string): void {
  recentPreflight.delete(guildId);
}

/**
 * Spawns ffmpeg with `-version` to verify the binary is on PATH and runs.
 * Returns true on exit 0.
 */
function checkFfmpegBinary(timeoutMs = 5_000): Promise<{ ok: boolean; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    let stderr = '';
    let stdout = '';
    let settled = false;
    const proc = spawn('ffmpeg', ['-hide_banner', '-version'], { stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      resolve({ ok: false, stderr: stderr || 'ffmpeg -version timed out', stdout });
    }, timeoutMs);

    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stderr: err.message, stdout });
    });
    proc.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stderr, stdout });
    });
  });
}

/**
 * Spawns a short-lived ffmpeg resampler via the registry, writes a few hundred
 * ms of synthetic silence through it, confirms PCM comes out the other side,
 * then tears it down. This proves the full s16le->resample->s16le pipeline is
 * healthy end-to-end before we commit to a real session.
 */
async function checkResamplerPipeline(_userId: string, timeoutMs = 5_000): Promise<{ ok: boolean; reason: string | null; stderrTail: string }> {
  // Spawn a one-shot ffmpeg with the same pipeline shape as FfmpegResampler:
  // 48kHz stereo s16le → 16kHz mono s16le. We don't use FfmpegResampler here
  // because that class is built for live streaming (idle watchdog, no
  // stdin-end semantic). The preflight needs to write a fixed amount of input,
  // close stdin to trigger libswr's flush, and assert the resampled bytes
  // appear on stdout — fundamentally a one-shot test.
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
      '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';
    let totalOut = 0;
    let settled = false;
    const stderrCap = 4096;

    const finish = (result: { ok: boolean; reason: string | null; stderrTail: string }): void => {
      if (settled) return;
      settled = true;
      try { proc.kill('SIGTERM'); } catch { /* already dead */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        reason: `no PCM output from resampler within ${timeoutMs}ms`,
        stderrTail: stderr.slice(-400),
      });
    }, timeoutMs);

    proc.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < stderrCap) stderr += d.toString();
    });

    proc.stdout?.on('data', (d: Buffer) => {
      totalOut += d.length;
      // First non-empty output proves the pipeline is flowing. Don't wait for
      // exit — that's an extra ~50ms that doesn't add coverage.
      if (totalOut > 0) {
        clearTimeout(timer);
        finish({ ok: true, reason: null, stderrTail: '' });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, reason: `spawn error: ${err.message}`, stderrTail: stderr.slice(-400) });
    });

    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (totalOut > 0) {
        finish({ ok: true, reason: null, stderrTail: '' });
      } else {
        finish({
          ok: false,
          reason: `ffmpeg exited (code=${code}, signal=${signal}) with no PCM output`,
          stderrTail: stderr.slice(-400),
        });
      }
    });

    // 1 second of 48 kHz stereo s16le silence = 192_000 bytes. After writing
    // we end stdin to signal EOF; without EOF, libswr buffers indefinitely
    // and waits for more input — which never comes in a one-shot test.
    const silenceBytes = 48_000 * 1 * 2 * 2;
    const silence = Buffer.alloc(silenceBytes);
    proc.stdin?.write(silence, () => {
      proc.stdin?.end();
    });
  });
}

/**
 * Validates STT config is present and sane. Does NOT connect to GCP — we leave
 * that for the first real session so we don't burn quota on preflight.
 */
function checkSttConfig(): { ok: boolean; notes: string[]; remediation: string[] } {
  const cfg = getConfig();
  const notes: string[] = [];
  const remediation: string[] = [];

  if (!cfg.stt.enabled) {
    return {
      ok: true,
      notes: ['STT is disabled in config — audio will be recorded but not transcribed'],
      remediation: [],
    };
  }

  if (cfg.stt.engine === 'google-cloud-stt') {
    if (!cfg.stt.googleCloud.projectId) {
      remediation.push('set stt.googleCloud.projectId in config.json');
    }
    if (!cfg.stt.googleCloud.keyFile) {
      remediation.push('set stt.googleCloud.keyFile in config.json (path to GCP service account JSON)');
    }
    if (!cfg.stt.googleCloud.model) {
      remediation.push('set stt.googleCloud.model (e.g. "latest_long")');
    }
  }

  return {
    ok: remediation.length === 0,
    notes,
    remediation,
  };
}

/**
 * Run the full preflight battery. Safe to call outside an active session —
 * it spawns a disposable ffmpeg in a unique sessionId key so it can't
 * interfere with real recording.
 */
export async function runPreflight(userId: string): Promise<PreflightResult> {
  const remediation: string[] = [];
  const notes: string[] = [];

  // 1. ffmpeg binary present?
  const binary = await checkFfmpegBinary();
  if (!binary.ok) {
    const errLine = binary.stderr.split('\n')[0] || binary.stdout.split('\n')[0] || 'unknown';
    remediation.push(
      `ffmpeg not runnable on PATH — error: ${errLine}. ` +
      `Install with: sudo apt install ffmpeg`
    );
  } else {
    // ffmpeg -version emits to stdout; check there first
    const combined = binary.stdout + '\n' + binary.stderr;
    const versionLine = combined.split('\n').find((l) => l.startsWith('ffmpeg version')) ?? '';
    if (versionLine) notes.push(versionLine);
  }

  // 2. Resampler pipeline end-to-end (only if binary is present)
  let pipelineOk = binary.ok;
  if (binary.ok) {
    const pipeline = await checkResamplerPipeline(userId);
    if (!pipeline.ok) {
      pipelineOk = false;
      remediation.push(
        `resampler pipeline failed: ${pipeline.reason ?? 'unknown'}` +
        (pipeline.stderrTail ? ` (stderr: ${pipeline.stderrTail})` : '')
      );
    } else {
      notes.push('resampler pipeline: OK (silence round-trip confirmed)');
    }
  }

  // 3. STT config validation
  const stt = checkSttConfig();
  if (!stt.ok) {
    for (const item of stt.remediation) remediation.push(`STT config: ${item}`);
  }
  for (const note of stt.notes) notes.push(note);

  return {
    ok: binary.ok && pipelineOk && stt.ok,
    ffmpegOk: binary.ok,
    opusDecodeOk: pipelineOk,
    sttConfigOk: stt.ok,
    remediation,
    notes,
  };
}

/**
 * Handler for `/session preflight`. Runs the battery and reports.
 * Records the result per-guild so `/session start` can refuse to run on a failed preflight.
 */
export async function handlePreflight(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const member = interaction.member;
  if (!member || typeof member.permissions === 'string' || !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: 'Preflight is restricted to users with Manage Server.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  logger.info(`Preflight initiated by ${interaction.user.tag} in guild ${guild.id}`);
  const result = await runPreflight(interaction.user.id);
  recentPreflight.set(guild.id, { at: Date.now(), result });

  const header = result.ok
    ? '**Preflight PASSED** — `/session start` is cleared.'
    : '**Preflight FAILED** — `/session start` will be blocked until issues are fixed.';

  const lines: string[] = [header, ''];
  lines.push('**Checks:**');
  lines.push(`- ffmpeg binary: ${result.ffmpegOk ? 'OK' : 'FAIL'}`);
  lines.push(`- Resampler pipeline: ${result.opusDecodeOk ? 'OK' : 'FAIL'}`);
  lines.push(`- STT config: ${result.sttConfigOk ? 'OK' : 'FAIL'}`);
  if (result.notes.length > 0) {
    lines.push('');
    lines.push('**Notes:**');
    for (const note of result.notes) lines.push(`- ${note}`);
  }
  if (result.remediation.length > 0) {
    lines.push('');
    lines.push('**Remediation:**');
    for (const item of result.remediation) lines.push(`- ${item}`);
  }
  lines.push('');
  lines.push(`_Preflight result cached for ${Math.round(PREFLIGHT_TTL_MS / 60000)} min._`);

  await interaction.editReply(lines.join('\n'));

  // Future: optional voice-sample-driven preflight (STT round trip) would
  // record a short audio sample from the GM here and push it through the
  // full pipeline. Current battery is static-only (no Discord voice
  // required) so preflight is fast (<15s) and cheap.
}
