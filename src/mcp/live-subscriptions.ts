import { EventEmitter } from 'events';
import type { TranscriptEvent } from '../stt/types.js';
import { logger } from '../logger.js';

interface StoredSegment {
  rowId: number;
  event: TranscriptEvent;
}

/**
 * Manages live transcript streaming with throttling and backpressure.
 * - Throttles interim results to max 2/sec per user
 * - Buffers up to 100 events, drops oldest with gap notification
 */
export class LiveTranscriptManager extends EventEmitter {
  private buffer: StoredSegment[] = [];
  private lastInterimByUser = new Map<string, number>(); // userId → last emit timestamp
  private interimThrottleMs: number;

  static readonly MAX_BUFFER_SIZE = 100;

  constructor(interimThrottlePerSecond: number = 2) {
    super();
    this.interimThrottleMs = 1000 / interimThrottlePerSecond;
  }

  /**
   * Called when a transcript segment is stored to the database.
   * Throttles interims and buffers for SSE push.
   */
  onTranscriptStored(rowId: number, event: TranscriptEvent): void {
    // Throttle interim results
    if (!event.isFinal) {
      const now = Date.now();
      const lastEmit = this.lastInterimByUser.get(event.userId) ?? 0;
      if (now - lastEmit < this.interimThrottleMs) {
        return; // Skip this interim — too frequent
      }
      this.lastInterimByUser.set(event.userId, now);
    }

    // Add to buffer
    const segment: StoredSegment = { rowId, event };

    if (this.buffer.length >= LiveTranscriptManager.MAX_BUFFER_SIZE) {
      // Drop oldest and emit gap notification
      const dropped = this.buffer.shift()!;
      this.emit('gap', {
        droppedId: dropped.rowId,
        currentId: rowId,
        message: 'Buffer overflow — use ?after_id= to catch up',
      });
    }

    this.buffer.push(segment);

    // Emit for SSE push
    this.emit('segment', {
      rowId,
      userId: event.userId,
      displayName: event.displayName,
      speakerLabel: event.speakerLabel,
      segmentStart: event.segmentStart,
      segmentEnd: event.segmentEnd,
      transcript: event.transcript,
      confidence: event.confidence,
      isFinal: event.isFinal,
      type: event.isFinal ? 'final' : 'interim',
    });
  }

  /** Get buffered events after a given row ID (for client recovery). */
  getBufferAfterId(afterId: number): StoredSegment[] {
    return this.buffer.filter((s) => s.rowId > afterId);
  }

  destroy(): void {
    this.buffer = [];
    this.lastInterimByUser.clear();
    this.removeAllListeners();
  }
}
