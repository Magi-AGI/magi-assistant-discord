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
