import { TranscriptChangedError, type TranscriptSource } from "../transcript/index.ts";
import {
  type Batch, type ByteRange, type Checkpoint, type CheckpointSnapshot, type CollectorStorage, type CommitResult,
  type SourceScope, type StreamKey, StorageBackoffError, StorageUnavailableError,
} from "../storage/collector-storage.ts";
import { CheckpointProof } from "./checkpoint-proof.ts";
import { ScanPendingError } from "./scan-pending.ts";
import { ScanRejectedError, type RejectedBatch } from "./scan-rejected.ts";

export interface ScanRestart extends CheckpointSnapshot {
  reset?: true;
}

export class ScanRecovery {
  private lastRecoveryOffset = -1;

  constructor(
    private readonly storage: Pick<CollectorStorage, "commit" | "readCheckpoint">,
    private readonly transcript: Pick<TranscriptSource<unknown>, "fileSize" | "prefixDigests">,
  ) {}

  /** Read from storage. If the request fails in transport, the scan of the target becomes pending. */
  static async read<T>(target: StreamKey | SourceScope, read: () => Promise<T>, byteRange?: ByteRange): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (!StorageUnavailableError.is(error)) throw error;
      const delay = error instanceof StorageBackoffError ? error.retryAfterMs : undefined;
      throw new ScanPendingError("storage-unavailable", target, byteRange, delay);
    }
  }

  /** Return a rejection or the durable starting point for a replacement cursor. */
  async commit(batch: Batch, previous: Checkpoint | null, startOffset: number): Promise<ScanRestart | RejectedBatch | undefined> {
    const endOffset = batch.checkpoint.offset;
    // An unresolved write leaves any skipped prefix pending from the durable checkpoint.
    const byteRange = { startOffset: Math.min(startOffset, batch.expectedOffset), endOffset };
    let outcome: CommitResult | "storage-unavailable";
    try {
      outcome = await this.storage.commit(batch);
    } catch (error) {
      if (error instanceof StorageBackoffError) throw new ScanPendingError("storage-unavailable", batch.source, byteRange, error.retryAfterMs);
      if (!StorageUnavailableError.is(error)) throw error;
      outcome = "storage-unavailable";
    }
    if (outcome === "committed") return;
    if (outcome === "invalid") return ScanRejectedError.batch(batch.source, { startOffset, endOffset });
    const winner = await ScanRecovery.read(batch.source, () => this.storage.readCheckpoint(batch.source), byteRange);
    const reason = outcome === "conflict" ? "version-conflict" : "storage-unavailable";
    const pending = () => new ScanPendingError(reason, batch.source, byteRange);
    const offset = winner.checkpoint?.offset ?? 0;
    if (winner.version <= batch.expectedVersion || (!winner.checkpoint && previous)) throw pending();
    if (offset === this.lastRecoveryOffset && !CheckpointProof.same(winner.checkpoint, batch.checkpoint)) throw pending();
    // A session version alone can explain a conflict, but cannot confirm a lost write on this source.
    if (CheckpointProof.same(winner.checkpoint, previous)) {
      if (outcome === "storage-unavailable") throw pending();
      if (batch.resetFrom) {
        // Another source advanced the session. This source still needs the same compare-and-reset.
        this.lastRecoveryOffset = offset;
        return { ...winner, reset: true };
      }
    }
    if (!batch.resetFrom && offset < batch.expectedOffset) throw pending();
    if (winner.checkpoint && !await this.matchesCapture(winner.checkpoint)) throw pending();
    this.lastRecoveryOffset = offset;
    return winner;
  }

  private async matchesCapture(checkpoint: Checkpoint): Promise<boolean> {
    try {
      return !!await CheckpointProof.capture(this.transcript, checkpoint);
    } catch (error) {
      if (error instanceof TranscriptChangedError) return false;
      throw error;
    }
  }
}
