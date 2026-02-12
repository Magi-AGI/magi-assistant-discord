import { insertSttUsage } from '../db/queries.js';
import { logger } from '../logger.js';
import type { SttConfig } from '../types/index.js';

/**
 * Tracks cumulative STT usage for a session.
 * Speech-minutes-only counting with cost estimation (20% buffer).
 */
export class SttUsageTracker {
  private sessionId: string;
  private engine: string;
  private totalSpeechMs = 0;
  private segmentCount = 0;
  private costWarningThreshold: number;
  private warningEmitted = false;

  constructor(sessionId: string, config: SttConfig) {
    this.sessionId = sessionId;
    this.engine = config.engine;
    this.costWarningThreshold = config.costWarningPerSessionUsd;
  }

  /** Add speech duration (called for each final transcript segment). */
  addSpeechDuration(durationMs: number): void {
    this.totalSpeechMs += durationMs;
    this.segmentCount++;

    // Check cost warning
    if (!this.warningEmitted) {
      const cost = this.estimateCost();
      if (cost >= this.costWarningThreshold) {
        logger.warn(
          `STT cost warning for session ${this.sessionId}: estimated $${cost.toFixed(2)} ` +
          `(${(this.totalSpeechMs / 60000).toFixed(1)} speech-minutes, ${this.segmentCount} segments)`
        );
        this.warningEmitted = true;
      }
    }
  }

  /** Estimate cost: speech_minutes * $0.024 * 1.2 (20% buffer). */
  estimateCost(): number {
    const speechMinutes = this.totalSpeechMs / 60000;
    return speechMinutes * 0.024 * 1.2;
  }

  /** Flush usage to database (called at session end). */
  flush(): void {
    if (this.totalSpeechMs === 0) return;

    insertSttUsage({
      sessionId: this.sessionId,
      engine: this.engine,
      audioDurationMs: this.totalSpeechMs,
      segmentCount: this.segmentCount,
      estimatedCostUsd: this.estimateCost(),
    });

    logger.info(
      `STT usage for session ${this.sessionId}: ${(this.totalSpeechMs / 60000).toFixed(1)} speech-minutes, ` +
      `${this.segmentCount} segments, estimated $${this.estimateCost().toFixed(2)}`
    );
  }
}
