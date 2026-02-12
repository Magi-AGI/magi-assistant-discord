import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config.js';
import { logger } from './logger.js';
import {
  getSessionsOlderThan,
  deleteSessionCascade,
  getSessionTracks,
  deleteUserDataInGuild,
  getUserAudioTracks,
} from './db/queries.js';

let retentionTimer: ReturnType<typeof setInterval> | null = null;

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function startRetentionCleanup(): void {
  const config = getConfig();
  if (config.dataRetention.sessionRetentionDays <= 0) {
    logger.info('Data retention: disabled (sessionRetentionDays=0)');
    return;
  }

  logger.info(`Data retention: sessions older than ${config.dataRetention.sessionRetentionDays} days will be purged`);

  // Run once on startup, then daily
  runRetentionCleanup();
  retentionTimer = setInterval(runRetentionCleanup, CLEANUP_INTERVAL_MS);
}

export function stopRetentionCleanup(): void {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
    logger.info('Data retention: cleanup timer stopped');
  }
}

function runRetentionCleanup(): void {
  const config = getConfig();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - config.dataRetention.sessionRetentionDays);
  const cutoffIso = cutoff.toISOString();

  const oldSessions = getSessionsOlderThan(cutoffIso);
  if (oldSessions.length === 0) return;

  logger.info(`Data retention: found ${oldSessions.length} session(s) older than ${cutoffIso}`);

  for (const session of oldSessions) {
    try {
      purgeSession(session.id);
    } catch (err) {
      logger.error(`Data retention: failed to purge session ${session.id}:`, err);
    }
  }
}

export function purgeSession(sessionId: string): void {
  const config = getConfig();

  // Delete audio files if configured
  if (config.dataRetention.autoDeleteAudioFiles) {
    const tracks = getSessionTracks(sessionId);
    for (const track of tracks) {
      try {
        const absPath = path.resolve(track.file_path);
        if (fs.existsSync(absPath)) {
          fs.unlinkSync(absPath);
          logger.debug(`Purge: deleted audio file ${track.file_path}`);
        }
      } catch (err) {
        logger.warn(`Purge: could not delete audio file ${track.file_path}:`, err);
      }
    }

    // Remove session directory recursively (includes hydrated/ subdirectory and any other artifacts)
    const sessionDir = path.resolve(config.dataDir, sessionId);
    try {
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        logger.debug(`Purge: removed session directory ${sessionDir}`);
      }
    } catch {
      // Non-critical
    }
  }

  // Delete all database records
  deleteSessionCascade(sessionId);
  logger.info(`Purge: session ${sessionId} deleted`);
}

export function forgetUser(guildId: string, userId: string): { sessionsAffected: number; segmentsDeleted: number; tracksDeleted: number; audioFilesDeleted: number } {
  // Find and delete audio files before deleting DB records
  let audioFilesDeleted = 0;
  const userTracks = getUserAudioTracks(guildId, userId);
  for (const track of userTracks) {
    try {
      const absPath = path.resolve(track.file_path);
      if (fs.existsSync(absPath)) {
        fs.unlinkSync(absPath);
        audioFilesDeleted++;
        logger.debug(`Forget user: deleted audio file ${track.file_path}`);
      }
    } catch (err) {
      logger.warn(`Forget user: could not delete audio file ${track.file_path}:`, err);
    }
  }

  const result = deleteUserDataInGuild(guildId, userId);
  logger.info(
    `Forget user ${userId} in guild ${guildId}: ${result.segmentsDeleted} segments, ` +
    `${result.tracksDeleted} tracks, ${audioFilesDeleted} audio files across ${result.sessionsAffected} sessions`
  );
  return { ...result, audioFilesDeleted };
}
