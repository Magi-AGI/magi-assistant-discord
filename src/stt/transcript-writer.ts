import type { TranscriptEvent } from './types.js';
import {
  insertTranscriptSegment,
  findBurstForTimestamp,
} from '../db/queries.js';
import { logger } from '../logger.js';

interface CachedBurst {
  burstId: number;
  startTime: string;
  endTime: string | null;
}

/**
 * Persists transcript events to the database.
 * Handles interim→final updates using the composite key (session_id, user_id, stream_sequence, stt_result_id).
 *
 * Caches the current burst per user to avoid re-querying the DB on every
 * interim event (which can fire 10+ times/sec with 5+ players).
 */
export class TranscriptWriter {
  private sessionId: string;
  private userTrackMap = new Map<string, number>(); // userId → trackId
  private userDisplayNameMap = new Map<string, string>(); // userId → displayName
  private speakerDisplayNameMap = new Map<string, string>(); // speakerLabel → displayName (diarized mode)
  private burstCache = new Map<string, CachedBurst | null>(); // userId → cached burst

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** Register a user's track ID for burst mapping. Clears stale burst cache. */
  setUserTrackId(userId: string, trackId: number): void {
    this.userTrackMap.set(userId, trackId);
    // Invalidate burst cache — track change means bursts belong to different track
    this.burstCache.delete(userId);
  }

  /** Register a user's display name so transcripts are attributed to human-readable names. */
  setUserDisplayName(userId: string, displayName: string): void {
    this.userDisplayNameMap.set(userId, displayName);
  }

  /** Register a speaker label → display name mapping (diarized mode). Applies to future segments. */
  setSpeakerDisplayName(speakerLabel: string, displayName: string): void {
    this.speakerDisplayNameMap.set(speakerLabel, displayName);
  }

  /**
   * Write a transcript event to the database.
   * Returns the row ID for live subscription emission.
   *
   * Uses UPSERT (INSERT ON CONFLICT) when stt_result_id is present, so
   * interim→final updates are atomic regardless of arrival order.
   */
  write(event: TranscriptEvent): number | null {
    const trackId = this.userTrackMap.get(event.userId);
    if (trackId === undefined) {
      logger.warn(`TranscriptWriter: no track registered for user ${event.userId}`);
      return null;
    }

    // Use cached burst lookup to avoid DB queries on every interim
    const burst = this.getCachedBurst(event.userId, trackId, event.segmentStart);

    // UPSERT handles both fresh inserts and interim→final updates atomically
    const rowId = insertTranscriptSegment({
      sessionId: this.sessionId,
      trackId,
      burstId: burst?.burstId ?? null,
      userId: event.userId,
      displayName: event.displayName
        ?? (event.speakerLabel ? this.speakerDisplayNameMap.get(event.speakerLabel) : undefined)
        ?? this.userDisplayNameMap.get(event.userId)
        ?? null,
      speakerLabel: event.speakerLabel,
      segmentStart: event.segmentStart,
      segmentEnd: event.segmentEnd,
      transcript: event.transcript,
      confidence: event.confidence,
      language: 'en',
      isFinal: event.isFinal,
      sttResultId: event.sttResultId,
      streamSequence: event.streamSequence,
      sttEngine: event.sttEngine,
      sttModel: event.sttModel,
    });

    // Invalidate burst cache on finals (burst range may have shifted)
    if (event.isFinal) {
      this.burstCache.delete(event.userId);
    }

    return rowId;
  }

  /**
   * Get the burst for a timestamp, using a per-user cache.
   * Only re-queries the DB if the timestamp falls outside the cached burst range
   * or if the cache is empty.
   */
  private getCachedBurst(userId: string, trackId: number, segmentStart: string): CachedBurst | null {
    const cached = this.burstCache.get(userId);

    // Check if the cached burst covers this timestamp
    if (cached !== undefined) {
      if (cached === null) {
        // Previously queried and found no burst — re-query only if timestamp changed significantly
        // For simplicity, always re-query on null cache (cheap if no bursts exist)
      } else if (this.timestampInRange(segmentStart, cached.startTime, cached.endTime)) {
        return cached;
      }
    }

    // Cache miss — query DB
    const burst = findBurstForTimestamp(trackId, segmentStart);
    if (burst) {
      const entry: CachedBurst = {
        burstId: burst.id,
        startTime: burst.burst_start,
        endTime: burst.burst_end ?? null,
      };
      this.burstCache.set(userId, entry);
      return entry;
    }

    this.burstCache.set(userId, null);
    return null;
  }

  private timestampInRange(ts: string, start: string, end: string | null): boolean {
    if (ts < start) return false;
    if (end !== null && ts > end) return false;
    return true;
  }
}
