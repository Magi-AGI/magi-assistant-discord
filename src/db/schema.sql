-- user_version = 1

CREATE TABLE sessions (
    id               TEXT PRIMARY KEY,  -- UUID
    guild_id         TEXT NOT NULL,
    voice_channel_id TEXT NOT NULL,
    text_channel_ids TEXT,              -- JSON array of monitored channel IDs
    timezone         TEXT NOT NULL,     -- From config, e.g. "America/New_York"
    started_at       TEXT NOT NULL,     -- ISO 8601 with timezone
    ended_at         TEXT,
    status           TEXT NOT NULL DEFAULT 'active',  -- active | stopped | error
    metadata         TEXT               -- JSON blob for extensibility
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
    started_at          TEXT NOT NULL,     -- Wall-clock ISO 8601 when subscription was created
    first_packet_at     TEXT,              -- Wall-clock ISO 8601 of first audio packet received
    ended_at            TEXT,
    codec               TEXT NOT NULL DEFAULT 'opus',
    container           TEXT NOT NULL DEFAULT 'ogg'
);

CREATE TABLE audio_speech_bursts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id            INTEGER NOT NULL REFERENCES audio_tracks(id),
    burst_start         TEXT NOT NULL,     -- Wall-clock ISO 8601 ms precision
    burst_end           TEXT,              -- Wall-clock ISO 8601 ms precision (NULL if still speaking)
    start_frame_offset  INTEGER NOT NULL,  -- Opus frame index at burst start
    end_frame_offset    INTEGER            -- Opus frame index at burst end (NULL if still speaking)
);

CREATE INDEX idx_audio_speech_bursts_track ON audio_speech_bursts(track_id);

CREATE TABLE text_events (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id          TEXT NOT NULL REFERENCES sessions(id),
    message_id          TEXT NOT NULL,     -- Discord message snowflake (not unique)
    user_id             TEXT,              -- Nullable: may be unavailable for deletes
    channel_id          TEXT NOT NULL,
    message_timestamp   TEXT,              -- Discord's own timestamp, ISO 8601. Nullable for uncached deletes.
    event_received_at   TEXT NOT NULL,     -- Wall-clock ISO 8601 when bot received the event
    content             TEXT,              -- Nullable: unavailable for deletes of uncached messages
    event_type          TEXT NOT NULL DEFAULT 'create'  -- create | edit | delete
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
    text_channels       TEXT    -- JSON array of channel IDs to monitor
);
