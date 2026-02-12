export interface TranscriptEvent {
  userId: string;
  displayName: string | null;
  speakerLabel: string | null;
  segmentStart: string;
  segmentEnd: string | null;
  transcript: string;
  confidence: number | null;
  isFinal: boolean;
  sttResultId: string | null;
  streamSequence: number;
  sttEngine: string;
  sttModel: string | null;
}

export interface SttStream {
  write(pcm: Buffer): void;
  close(): void;
  readonly open: boolean;
  /** Called when the stream closes unexpectedly (server error / duration limit). */
  onClose?: () => void;
}

export type TranscriptCallback = (event: TranscriptEvent) => void;

export interface SttEngine {
  createStream(userId: string, streamSequence: number, onTranscript: TranscriptCallback): SttStream;
  destroy(): void;
}
