/**
 * Deterministic regression test for the rejoin-grace state machine (#30).
 *
 * Exercises the grace window directly via session-manager helpers using a
 * stubbed VoiceReceiver — no live Discord gateway, no ffmpeg, no STT.
 * Asserts:
 *   1. Leave + rejoin within grace: track preserved, gap row opened then closed,
 *      same trackId, frame count continues.
 *   2. Leave with no return: grace timer fires teardown, gap row is closed
 *      with end frame offset, audio track is ended.
 *   3. Session-level cleanup mid-grace cancels timers and closes open gaps.
 *
 * Runs against a temporary SQLite DB and config in an isolated tmp dir so it
 * never touches the real bot state. Exits non-zero on any assertion failure.
 *
 * Usage:
 *   npm run build && node dist/scripts/test-voice-disconnect-grace.js
 *   # or for development:
 *   tsx scripts/test-voice-disconnect-grace.ts
 */

import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

const GRACE_MS = 250; // short for fast tests

async function main(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magi-grace-test-'));
  const sessionId = 'grace-test-session';
  const sessionDir = path.join(tmpDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  // Write minimal config.json so getConfig() resolves cleanly.
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        dataDir: tmpDir,
        dbPath: path.join(tmpDir, 'bot.sqlite'),
        voiceRejoinGraceMs: GRACE_MS,
        guilds: {},
      },
      null,
      2,
    ),
  );

  const originalCwd = process.cwd();
  process.chdir(tmpDir);

  // Reset env so the production token requirements don't trip during config load.
  delete process.env.DISCORD_TOKEN;
  delete process.env.DISCORD_CLIENT_ID;

  let failed = 0;
  const results: Array<{ name: string; ok: boolean; err?: unknown }> = [];

  try {
    // Imports happen after chdir so dotenv + config load against the tmp dir.
    const { initDb, closeDb } = await import('../src/db/index.js');
    const queries = await import('../src/db/queries.js');
    const { BurstTracker } = await import('../src/voice/burst-tracker.js');
    const sessionMgr = await import('../src/session-manager.js');

    initDb();

    // Insert the session + a synthetic participant + audio track so the gap
    // rows have a valid track_id FK to bind to.
    queries.insertSession({
      id: sessionId,
      guildId: 'guild-test',
      voiceChannelId: 'vc-test',
      textChannelIds: [],
      timezone: 'UTC',
      startedAt: new Date().toISOString(),
    });

    const userId = 'user-alice';
    const displayName = 'Alice';
    queries.insertParticipant({
      sessionId,
      userId,
      displayName,
      joinedAt: new Date().toISOString(),
    });

    const trackId = queries.insertAudioTrack({
      sessionId,
      userId,
      filePath: path.join(sessionDir, `${userId}_0_t1.ogg`),
      startedAt: new Date().toISOString(),
    });
    queries.setFirstPacketAt(trackId, new Date().toISOString());

    // --- Test 1: leave + rejoin within grace ---------------------------
    // Build a fake ActiveSession with a stub receiver and a real BurstTracker.
    // The recorder stub returns our pre-inserted track row so openGap/closeGap
    // can record gap_frame offsets against the real DB row.
    const stubFrameCount = { value: 100 };
    const stubTrack = {
      userId,
      trackId,
      trackNumber: 0,
      filePath: '',
      stream: new Readable({ read() {} }),
      muxer: { writeOpusPacket() {}, finalize() {} },
      writeStream: { end() {} },
      get frameCount() {
        return stubFrameCount.value;
      },
      firstPacketRecorded: true,
      closed: false,
      partNumber: 0,
      rebindCount: 0,
    };
    const stubRecorder = {
      getTrack: (uid: string) => (uid === userId ? stubTrack : undefined),
      closeUserTrack: () => {
        stubTrack.closed = true;
        queries.endAudioTrack(trackId, new Date().toISOString());
      },
      closeAll: () => {
        stubTrack.closed = true;
      },
      getAllTracks: () => (stubTrack.closed ? [] : [stubTrack]),
      subscribeUser: () => stubTrack,
    };
    const stubReceiver = {
      speaking: new EventEmitter(),
      subscribe: () => stubTrack.stream,
    };

    // BurstTracker is the real one — it owns the gap-row writes we want to verify.
    const burstTracker = new BurstTracker(
      sessionId,
      stubRecorder as unknown as import('../src/voice/recorder.js').SessionRecorder,
      stubReceiver as unknown as import('@discordjs/voice').VoiceReceiver,
    );

    const session = {
      id: sessionId,
      guildId: 'guild-test',
      voiceChannelId: 'vc-test',
      textChannelIds: [],
      connection: { destroy() {} } as unknown as import('@discordjs/voice').VoiceConnection,
      receiver: stubReceiver as unknown as import('@discordjs/voice').VoiceReceiver,
      startedAt: new Date(),
      statusMessageId: null,
      statusChannelId: null,
      originalNickname: null,
      nicknameChanged: false,
      statusPinned: false,
      recorder: stubRecorder as unknown as import('../src/voice/recorder.js').SessionRecorder,
      burstTracker,
      notifiedUsers: new Set([userId]),
      diarized: false,
      gmUserId: userId,
      sttProcessor: null,
      transcriptWriter: null,
      usageTracker: null,
      liveTranscripts: null,
      resyncTimer: null,
      pendingRejoinTimers: new Map(),
      tearingDown: false,
    } as unknown as import('../src/session-manager.js').ActiveSession;

    await runCase('leave + rejoin within grace preserves track', results, async () => {
      sessionMgr.scheduleUserRejoinGrace(session, userId, displayName, 'voiceStateUpdate leave');
      assert.equal(session.pendingRejoinTimers.has(userId), true, 'timer should be pending');

      const openGap = queries.getOpenGap(trackId);
      assert.ok(openGap, 'expected an open gap row');
      assert.equal(openGap!.reason, 'voiceStateUpdate leave');
      assert.equal(openGap!.start_frame_offset, 100);
      assert.equal(openGap!.end_frame_offset, null);

      // Simulate ~50ms passing during the disconnect — frame count would not
      // advance (no packets) but we keep it static here for clarity.
      await sleep(50);
      const cancelled = sessionMgr.cancelUserRejoinGrace(session, userId);
      assert.equal(cancelled, true, 'cancel should report a grace was pending');
      assert.equal(session.pendingRejoinTimers.has(userId), false);

      const gaps = queries.getTrackGaps(trackId);
      assert.equal(gaps.length, 1, 'exactly one gap row should exist');
      assert.equal(gaps[0].gap_end !== null, true, 'gap should be closed');
      assert.equal(gaps[0].end_frame_offset, 100);

      // The audio track should still be open (no end timestamp).
      const tracksAfter = queries.getSessionTracks(sessionId);
      assert.equal(tracksAfter[0].id, trackId, 'same track ID preserved across grace');
      assert.equal(tracksAfter[0].ended_at, null, 'track should still be open');
      assert.equal(stubTrack.closed, false, 'in-memory track should be open');
    });

    // --- Test 2: leave with no return → grace timer fires teardown ----
    await runCase('grace timeout finalizes teardown and closes gap', results, async () => {
      // Reset the in-memory track for a clean state.
      stubTrack.closed = false;
      stubFrameCount.value = 200;

      sessionMgr.scheduleUserRejoinGrace(session, userId, displayName, 'voiceStateUpdate leave');
      assert.equal(session.pendingRejoinTimers.has(userId), true);
      assert.ok(queries.getOpenGap(trackId), 'gap should be open immediately after schedule');

      // Wait past the grace window for the timer to fire.
      await sleep(GRACE_MS + 100);

      assert.equal(session.pendingRejoinTimers.has(userId), false, 'timer entry should be cleared');
      assert.equal(queries.getOpenGap(trackId), undefined, 'gap should be closed after timer');
      assert.equal(stubTrack.closed, true, 'track should be closed after teardown');

      const gaps = queries.getTrackGaps(trackId);
      // Two gaps total: one from test 1 (closed cleanly), one from this test (also closed).
      assert.equal(gaps.length, 2, 'two gap rows total across both tests');
      assert.equal(gaps[1].end_frame_offset, 200, 'second gap closed at frame 200');

      const partRow = queries.getSessionParticipants(sessionId).find((p) => p.user_id === userId);
      assert.ok(partRow?.left_at, 'participant should be marked left');
    });

    // --- Test 3: session-level cleanup mid-grace ----------------------
    // Insert a second user + track to exercise the bulk clear path.
    const userId2 = 'user-bob';
    queries.insertParticipant({ sessionId, userId: userId2, displayName: 'Bob', joinedAt: new Date().toISOString() });
    const trackId2 = queries.insertAudioTrack({
      sessionId,
      userId: userId2,
      filePath: path.join(sessionDir, `${userId2}_0_t2.ogg`),
      startedAt: new Date().toISOString(),
    });
    queries.setFirstPacketAt(trackId2, new Date().toISOString());

    // Add Bob to the recorder stub.
    const stubTrack2 = {
      ...stubTrack,
      userId: userId2,
      trackId: trackId2,
      closed: false,
      get frameCount() {
        return 50;
      },
    };
    stubRecorder.getTrack = (uid: string) => {
      if (uid === userId) return stubTrack;
      if (uid === userId2) return stubTrack2;
      return undefined;
    };
    session.notifiedUsers.add(userId2);

    await runCase('stopSession-style cleanup cancels pending grace + closes gaps', results, async () => {
      sessionMgr.scheduleUserRejoinGrace(session, userId2, 'Bob', 'voiceStateUpdate leave');
      assert.equal(session.pendingRejoinTimers.has(userId2), true);
      assert.ok(queries.getOpenGap(trackId2), 'Bob gap should be open');

      // Use the same helper that stopSession/forceEndSession/shutdownAllSessions
      // call to bulk-clear pending grace state.
      sessionMgr.clearAllPendingRejoinTimers(session);

      assert.equal(queries.getOpenGap(trackId2), undefined, 'Bob gap should be closed');
      // Bob's track should NOT be torn down by this path — the caller (stopSession)
      // does that via recorder.closeAll() afterward.
      const bobTrackRow = queries.getSessionTracks(sessionId).find((t) => t.id === trackId2);
      assert.equal(bobTrackRow?.ended_at, null, 'Bob track should still be open at this point');
    });

    closeDb();
  } finally {
    process.chdir(originalCwd);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* tmp cleanup best-effort */
    }
  }

  // --- Report ---
  console.log('\n=== Test results ===');
  for (const r of results) {
    if (r.ok) {
      console.log(`  PASS  ${r.name}`);
    } else {
      failed++;
      console.error(`  FAIL  ${r.name}`);
      console.error('        ' + (r.err instanceof Error ? r.err.stack : String(r.err)));
    }
  }
  console.log(`\n${results.length - failed}/${results.length} passed.`);
  process.exit(failed === 0 ? 0 : 1);
}

async function runCase(
  name: string,
  results: Array<{ name: string; ok: boolean; err?: unknown }>,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error('Fatal error in test runner:', err);
  process.exit(1);
});
