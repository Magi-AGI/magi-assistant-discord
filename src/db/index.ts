import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';

const CURRENT_SCHEMA_VERSION = 1;

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return _db;
}

export function initDb(): Database.Database {
  if (_db) return _db;

  const config = getConfig();
  const dbDir = path.dirname(path.resolve(config.dbPath));

  // Ensure the data directory exists
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  _db = new Database(config.dbPath);

  // WAL mode -- critical for concurrent reads/writes without blocking event loop
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');
  _db.pragma('foreign_keys = ON');

  // Run migrations
  migrate(_db);

  logger.info(`Database initialized at ${config.dbPath} (WAL mode, version ${CURRENT_SCHEMA_VERSION})`);
  return _db;
}

function migrate(db: Database.Database): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number;

  if (currentVersion < 1) {
    logger.info('Running migration: version 0 -> 1 (initial schema)');
    db.exec(SCHEMA_V1);
    db.pragma('user_version = 1');
  }

  // Future migrations go here:
  // if (currentVersion < 2) { ... db.pragma('user_version = 2'); }
}

/**
 * Crash recovery: mark any sessions left in 'active' status as 'error'.
 * Must be called AFTER initDb() and BEFORE the client emits 'ready'.
 */
export function recoverStaleSessions(): void {
  if (!_db) {
    throw new Error('recoverStaleSessions() called before initDb()');
  }
  const db = _db;
  const stale = db
    .prepare("SELECT id FROM sessions WHERE status = 'active'")
    .all() as { id: string }[];

  if (stale.length === 0) return;

  const update = db.prepare(
    "UPDATE sessions SET status = 'error', ended_at = ? WHERE id = ?"
  );

  const now = new Date().toISOString();
  const markAll = db.transaction(() => {
    for (const session of stale) {
      update.run(now, session.id);
      logger.warn(`Crash recovery: marked stale session ${session.id} as 'error'`);
    }
  });

  markAll();
  logger.info(`Crash recovery: cleaned up ${stale.length} stale session(s)`);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    logger.info('Database connection closed.');
  }
}

// --- Schema SQL (inlined to avoid file-copy issues with tsc) ---

const SCHEMA_V1 = `
CREATE TABLE sessions (
    id               TEXT PRIMARY KEY,
    guild_id         TEXT NOT NULL,
    voice_channel_id TEXT NOT NULL,
    text_channel_ids TEXT,
    timezone         TEXT NOT NULL,
    started_at       TEXT NOT NULL,
    ended_at         TEXT,
    status           TEXT NOT NULL DEFAULT 'active',
    metadata         TEXT
);

CREATE TABLE participants (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL REFERENCES sessions(id),
    user_id      TEXT NOT NULL,
    display_name TEXT NOT NULL,
    joined_at    TEXT NOT NULL,
    left_at      TEXT,
    UNIQUE(session_id, user_id, joined_at)
);

CREATE TABLE audio_tracks (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id          TEXT NOT NULL REFERENCES sessions(id),
    user_id             TEXT NOT NULL,
    file_path           TEXT NOT NULL,
    started_at          TEXT NOT NULL,
    first_packet_at     TEXT,
    ended_at            TEXT,
    codec               TEXT NOT NULL DEFAULT 'opus',
    container           TEXT NOT NULL DEFAULT 'ogg'
);

CREATE TABLE audio_speech_bursts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id            INTEGER NOT NULL REFERENCES audio_tracks(id),
    burst_start         TEXT NOT NULL,
    burst_end           TEXT,
    start_frame_offset  INTEGER NOT NULL,
    end_frame_offset    INTEGER
);

CREATE INDEX idx_audio_speech_bursts_track ON audio_speech_bursts(track_id);
CREATE UNIQUE INDEX idx_audio_speech_bursts_one_open ON audio_speech_bursts(track_id) WHERE burst_end IS NULL;

CREATE TABLE text_events (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id          TEXT NOT NULL REFERENCES sessions(id),
    message_id          TEXT NOT NULL,
    user_id             TEXT,
    channel_id          TEXT NOT NULL,
    message_timestamp   TEXT,
    event_received_at   TEXT NOT NULL,
    content             TEXT,
    event_type          TEXT NOT NULL DEFAULT 'create'
);

CREATE INDEX idx_text_events_message_id ON text_events(message_id);
CREATE INDEX idx_text_events_session_id ON text_events(session_id);
CREATE INDEX idx_text_events_session_timeline ON text_events(session_id, event_received_at);

CREATE TABLE consent (
    guild_id    TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    consented   INTEGER NOT NULL DEFAULT 1,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE guild_settings (
    guild_id            TEXT PRIMARY KEY,
    consent_required    INTEGER NOT NULL DEFAULT 0,
    timezone            TEXT NOT NULL DEFAULT 'UTC',
    text_channels       TEXT
);
`;
