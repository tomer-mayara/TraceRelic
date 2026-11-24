import type { TranscriptSource } from "../transcript/index.ts";
import type { CheckpointSnapshot, StreamKey } from "../storage/collector-storage.ts";

export type PrefixReader = Pick<TranscriptSource<unknown>, "prefixDigests">;

/** The scanner tells the watch schedule what storage has confirmed. */
export interface ScanProgress {
  now(): number;
  verified(source: StreamKey, snapshot: CheckpointSnapshot, transcript?: PrefixReader): Promise<void>;
  finishedSource(source: StreamKey): void;
}
