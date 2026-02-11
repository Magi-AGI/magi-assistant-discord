# Magi Assistant Discord

## Project
Discord bot for recording tabletop RPG sessions (per-user audio + text) for AI GM training data.

## Tech Stack
- TypeScript + Node.js
- discord.js v14 + @discordjs/voice
- SQLite via better-sqlite3 (WAL mode)
- prism-media for Opus/OGG handling

## Build & Run
- `npm run build` — compile TypeScript
- `npm run dev` — run with tsx (development)
- `npm start` — run compiled JS (production)
- `npm run hydrate-audio` — post-process session audio

## Project Structure
- `src/index.ts` — bot entry point
- `src/config.ts` — config loader (.env + config.json)
- `src/commands/` — slash command handlers
- `src/voice/` — audio recording subsystem
- `src/text/` — text channel capture
- `src/db/` — SQLite database, schema, queries
- `src/types/` — shared TypeScript types
- `scripts/` — standalone tools (hydrate-audio)

## Key Conventions
- All timestamps stored as ISO 8601 strings
- SQLite schema versioned via PRAGMA user_version
- Log output sanitized to strip Discord tokens
- Raw audio is speech-only; use hydration script for listenable files

## Opus TOC Byte Guard — Do Not Remove

The frame duration guard in `src/voice/recorder.ts` inspects the Opus TOC byte
of each raw packet before OGG muxing and logs a warning if the frame duration
is not the expected 20ms.

**This guard has caught real-world anomalies.** During Phase 1 testing, one
player's Discord client (DrWastelandMD) sent 40ms Opus frames with TOC byte
`0x32` instead of the standard 20ms frames. This means the assumption "1 packet
= 1 frame = 20ms = 960 samples" does not always hold.

**Why it matters:**
- The burst tracker's `start_frame_offset` / `end_frame_offset` assume each
  packet increments the frame counter by 1, representing 20ms of audio.
- If a packet actually contains 40ms, the frame counter undercounts real
  duration, causing the hydration script to misalign bursts.
- The guard surfaces this so we can investigate and adapt (e.g., count samples
  per packet instead of assuming 960).

**Behavior:** Warn only — the packet is still recorded. The guard does NOT
reject or skip non-20ms packets. This preserves all data while flagging the
mismatch for investigation.
