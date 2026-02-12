import { EventEmitter } from 'events';
import type { SttEngine, TranscriptEvent } from './types.js';
import type { SttConfig } from '../types/index.js';
import { VadGate } from './vad-gate.js';
import { ffmpegRegistry } from './process-registry.js';
import { logger } from '../logger.js';

/**
 * Per-session orchestrator managing VadGate instances for each user.
 * Emits 'transcript' events for downstream storage.
 */
export class SttProcessor extends EventEmitter {
  private gates = new Map<string, VadGate>();
  private engine: SttEngine;
  private config: SttConfig;
  private sessionId: string;
  private destroyed = false;

  constructor(engine: SttEngine, config: SttConfig, sessionId: string) {
    super();
    this.engine = engine;
    this.config = config;
    this.sessionId = sessionId;
  }

  addUser(userId: string): void {
    if (this.destroyed || this.gates.has(userId)) return;

    // Enforce maxConcurrentStreams
    if (this.config.maxConcurrentStreams > 0 && this.gates.size >= this.config.maxConcurrentStreams) {
      logger.warn(`SttProcessor: max concurrent streams (${this.config.maxConcurrentStreams}) reached, cannot add user ${userId}`);
      return;
    }

    const resampler = ffmpegRegistry.get(userId, this.sessionId);
    if (!resampler) {
      logger.warn(`SttProcessor: no ffmpeg resampler for user ${userId}, skipping`);
      return;
    }

    const gate = new VadGate(userId, this.engine, resampler, this.config);
    gate.on('transcript', (event: TranscriptEvent) => {
      this.emit('transcript', event);
    });
    gate.on('speechDuration', (durationMs: number) => {
      this.emit('speechDuration', durationMs);
    });

    this.gates.set(userId, gate);
    logger.debug(`SttProcessor: added user ${userId}`);
  }

  /** Check if a user has an active VadGate. */
  hasUser(userId: string): boolean {
    return this.gates.has(userId);
  }

  removeUser(userId: string): void {
    const gate = this.gates.get(userId);
    if (gate) {
      gate.destroy();
      this.gates.delete(userId);
      logger.debug(`SttProcessor: removed user ${userId}`);
    }
  }

  onSpeakingStart(userId: string): void {
    const gate = this.gates.get(userId);
    if (!gate) return;

    // Auto-rebind: if the resampler died (e.g. watchdog kill), respawn and recreate the gate
    const resampler = ffmpegRegistry.get(userId, this.sessionId);
    if (!resampler || !resampler.alive) {
      logger.warn(`SttProcessor: resampler dead for user ${userId}, respawning and rebinding gate`);
      gate.destroy();
      this.gates.delete(userId);
      ffmpegRegistry.spawn(userId, this.sessionId);
      this.addUser(userId);
      // Trigger speaking start on the freshly created gate
      this.gates.get(userId)?.onSpeakingStart();
      return;
    }

    gate.onSpeakingStart();
  }

  onSpeakingEnd(userId: string): void {
    this.gates.get(userId)?.onSpeakingEnd();
  }

  destroy(): void {
    this.destroyed = true;
    for (const [, gate] of this.gates) {
      gate.destroy();
    }
    this.gates.clear();
    // Engine lifecycle is managed by engine-factory (refcounted singleton),
    // not by individual session processors.
    this.removeAllListeners();
    logger.debug('SttProcessor: destroyed');
  }
}
