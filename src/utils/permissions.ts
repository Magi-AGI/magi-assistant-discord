import {
  type GuildChannel,
  type Guild,
  PermissionFlagsBits,
  PermissionsBitField,
} from 'discord.js';

export interface PermissionCheckResult {
  ok: boolean;
  missing: string[];
}

export function checkVoicePermissions(channel: GuildChannel): PermissionCheckResult {
  const me = channel.guild.members.me;
  if (!me) return { ok: false, missing: ['Cannot resolve bot member'] };

  const perms = channel.permissionsFor(me);
  if (!perms) return { ok: false, missing: ['Cannot resolve permissions'] };

  const missing: string[] = [];
  if (!perms.has(PermissionFlagsBits.Connect)) missing.push('Connect');
  if (!perms.has(PermissionFlagsBits.Speak)) missing.push('Speak');

  return { ok: missing.length === 0, missing };
}

export function checkTextPermissions(channel: GuildChannel): PermissionCheckResult {
  const me = channel.guild.members.me;
  if (!me) return { ok: false, missing: ['Cannot resolve bot member'] };

  const perms = channel.permissionsFor(me);
  if (!perms) return { ok: false, missing: ['Cannot resolve permissions'] };

  const missing: string[] = [];
  if (!perms.has(PermissionFlagsBits.SendMessages)) missing.push('Send Messages');
  if (!perms.has(PermissionFlagsBits.ViewChannel)) missing.push('View Channel');

  return { ok: missing.length === 0, missing };
}

export function checkManageMessages(channel: GuildChannel): PermissionCheckResult {
  const me = channel.guild.members.me;
  if (!me) return { ok: false, missing: ['Cannot resolve bot member'] };

  const perms = channel.permissionsFor(me);
  if (!perms) return { ok: false, missing: ['Cannot resolve permissions'] };

  const missing: string[] = [];
  if (!perms.has(PermissionFlagsBits.ManageMessages)) missing.push('Manage Messages');

  return { ok: missing.length === 0, missing };
}

export function checkNicknamePermission(guild: Guild): PermissionCheckResult {
  const me = guild.members.me;
  if (!me) return { ok: false, missing: ['Cannot resolve bot member'] };

  const missing: string[] = [];
  if (!me.permissions.has(PermissionFlagsBits.ChangeNickname)) missing.push('Change Nickname');

  return { ok: missing.length === 0, missing };
}

export function formatMissingPermissions(missing: string[]): string {
  return `Missing permissions: **${missing.join('**, **')}**`;
}
