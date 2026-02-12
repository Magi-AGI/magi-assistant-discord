import { type VoiceReceiver } from '@discordjs/voice';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import {
  insertBurst,
  closeBurst,
} from '../db/queries.js';
import type { SessionRecorder, UserTrack } from './recorder.js';

/** Tracks open burst IDs per user so we can close them efficiently. */
interface UserBurstState {
  burstId: number;
  openedAt: number; // Date.now() for max duration check
  checkTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Speech burst tracker for a session.
 *
 * Listens to VoiceReceiver 'speaking' events and logs burst boundaries
 * in the audio_speech_bursts table. Also enforces the max burst duration
 * guard with immediate reopen.
 */
export class BurstTracker {
  private sessionId: string;
  private recorder: SessionRecorder;
  private receiver: VoiceReceiver;
  private bursts = new Map<string, UserBurstState>();
  private maxBurstMs: number;
  private destroyed = false;

  /** Bound speaking handlers — stored for targeted removal in destroy(). */
  private boundOnStart: (userId: string) => void;
  private boundOnEnd: (userId: string) => void;

  constructor(sessionId: string, recorder: SessionRecorder, receiver: VoiceReceiver) {
    this.sessionId = sessionId;
    this.recorder = recorder;
    this.receiver = receiver;

    const config = getConfig();
    this.maxBurstMs = config.maxBurstDurationMinutes * 60 * 1000;

    // Bind handlers so we can remove them specifically in destroy()
    this.boundOnStart = (userId: string) => {
      if (this.destroyed) return;
      this.onSpeakingStart(userId);
    };
    this.boundOnEnd = (userId: string) => {
      if (this.destroyed) return;
      this.onSpeakingEnd(userId);
    };

    this.receiver.speaking.on('start', this.boundOnStart);
    this.receiver.speaking.on('end', this.boundOnEnd);
  }

  private onSpeakingStart(userId: string): void {
    // If a burst is already open for this user, it's a no-op
    // (could be a force-reopen that's still active)
    if (this.bursts.has(userId)) return;

    const track = this.recorder.getTrack(userId);
    if (!track) {
      logger.debug(`Speaking start for user ${userId} but no active track`);
      return;
    }

    this.openBurst(userId, track);
  }

  private onSpeakingEnd(userId: string): void {
    const state = this.bursts.get(userId);
    if (!state) return;

    const track = this.recorder.getTrack(userId);
    const frameOffset = track ? track.frameCount : 0;

    this.closeBurstState(userId, state, frameOffset);
  }

  /** Open a new burst for a user. */
  private openBurst(userId: string, track: UserTrack): void {
    const now = new Date();
    const burstId = insertBurst({
      trackId: track.trackId,
      burstStart: now.toISOString(),
      startFrameOffset: track.frameCount,
    });

    const state: UserBurstState = {
      burstId,
      openedAt: now.getTime(),
      checkTimer: null,
    };

    // Set up max burst duration guard
    state.checkTimer = setTimeout(() => {
      this.maxDurationGuard(userId);
    }, this.maxBurstMs);

    this.bursts.set(userId, state);
    logger.debug(
      `Burst ${burstId} opened for user ${userId} (track ${track.trackId}, frame ${track.frameCount})`
    );
  }

  /** Close a burst and clean up its timer. */
  private closeBurstState(userId: string, state: UserBurstState, endFrameOffset: number): void {
    if (state.checkTimer) {
      clearTimeout(state.checkTimer);
      state.checkTimer = null;
    }

    const now = new Date().toISOString();
    closeBurst(state.burstId, now, endFrameOffset);
    this.bursts.delete(userId);

    logger.debug(
      `Burst ${state.burstId} closed for user ${userId} (frame ${endFrameOffset})`
    );
  }

  /**
   * Max burst duration guard: force-close the burst and immediately reopen.
   * No gap between close and reopen -- the user may be genuinely mid-speech.
   */
  private maxDurationGuard(userId: string): void {
    if (this.destroyed) return;
    const state = this.bursts.get(userId);
    if (!state) return;

    const track = this.recorder.getTrack(userId);
    const frameOffset = track ? track.frameCount : 0;

    logger.warn(
      `Session ${this.sessionId}: max burst duration (${this.maxBurstMs / 60000}min) exceeded for user ${userId}, burst ${state.burstId} -- force-closing and reopening`
    );

    // Close the old burst
    this.closeBurstState(userId, state, frameOffset);

    // Immediately reopen if we still have an active track
    if (track) {
      this.openBurst(userId, track);
    }
  }

  /**
   * Close any open burst for a user (on leave/disconnect).
   * Does NOT reopen -- the user is gone.
   */
  closeUserBurst(userId: string): void {
    const state = this.bursts.get(userId);
    if (!state) return;

    const track = this.recorder.getTrack(userId);
    const frameOffset = track ? track.frameCount : 0;

    logger.debug(`Closing burst for leaving user ${userId}`);
    this.closeBurstState(userId, state, frameOffset);
  }

  /** Close all open bursts (session stop or shutdown). */
  closeAll(): void {
    for (const [userId, state] of this.bursts) {
      const track = this.recorder.getTrack(userId);
      const frameOffset = track ? track.frameCount : 0;
      this.closeBurstState(userId, state, frameOffset);
    }
  }

  /** Stop tracking and clean up all timers. */
  destroy(): void {
    this.destroyed = true;
    this.closeAll();
    // Remove only our own listeners — other components (SttProcessor) may share receiver.speaking
    this.receiver.speaking.off('start', this.boundOnStart);
    this.receiver.speaking.off('end', this.boundOnEnd);
  }
}
