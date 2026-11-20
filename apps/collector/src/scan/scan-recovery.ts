import { isDeepStrictEqual } from "node:util";
import { TranscriptChangedError, type TranscriptSource, type VerifiedPrefix } from "../history/index.ts";
import {
  type Batch, type ByteRange, type Checkpoint, type CheckpointSnapshot, type CollectorStorage, type CommitResult,
  type StreamKey, StorageUnavailableError,
} from "../storage/collector-storage.ts";
import { ScanPendingError } from "./scan-pending.ts";
import { rejectedBatch, type RejectedBatch } from "./scan-rejected.ts";

export async function readStorage<T>(source: StreamKey, read: () => Promise<T>, byteRange?: ByteRange): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (StorageUnavailableError.is(error)) throw new ScanPendingError("storage-unavailable", source, byteRange);
    throw error;
  }
}

export function checkpointPrefixes(checkpoint: Checkpoint | null): VerifiedPrefix[] {
  if (!checkpoint?.prefixDigest) return [];
  const accepted = { offset: checkpoint.offset, prefixDigest: checkpoint.prefixDigest };
  const prefixes = checkpoint.replayThrough ? [accepted, checkpoint.replayThrough] : [accepted];
  const fork = checkpoint.codexFork?.inheritedThrough;
  if (fork?.prefixDigest && fork.offset > accepted.offset) prefixes.push({ offset: fork.offset, prefixDigest: fork.prefixDigest });
  return prefixes;
}

export function verifiedCheckpoint(checkpoint: Checkpoint, digests: ReadonlyMap<number, string>): boolean {
  return !!checkpoint.prefixDigest && checkpointPrefixes(checkpoint).every(prefix => digests.get(prefix.offset) === prefix.prefixDigest);
}

export function sameCheckpoint(left: Checkpoint | null, right: Checkpoint | null): boolean {
  return left?.offset === right?.offset && left?.prefixDigest === right?.prefixDigest && left?.parserState === right?.parserState
    && left?.replayThrough?.offset === right?.replayThrough?.offset && left?.replayThrough?.prefixDigest === right?.replayThrough?.prefixDigest
    && left?.claudeCallOrigins === right?.claudeCallOrigins && isDeepStrictEqual(left?.codexFork, right?.codexFork);
}

export interface ScanRestart extends CheckpointSnapshot {
  reset?: true;
}

export class ScanRecovery {
  private lastRecoveryOffset = -1;

  constructor(
    private readonly storage: Pick<CollectorStorage, "commit" | "readCheckpoint">,
    private readonly transcript: Pick<TranscriptSource<unknown>, "fileSize" | "prefixDigests">,
  ) {}

  /** Return a rejection or the durable starting point for a replacement cursor. */
  async commit(batch: Batch, previous: Checkpoint | null, startOffset: number): Promise<ScanRestart | RejectedBatch | undefined> {
    let outcome: CommitResult | "storage-unavailable";
    try {
      outcome = await this.storage.commit(batch);
    } catch (error) {
      if (!StorageUnavailableError.is(error)) throw error;
      outcome = "storage-unavailable";
    }
    if (outcome === "committed") return;
    const endOffset = batch.checkpoint.offset;
    if (outcome === "invalid") return rejectedBatch(batch.source, { startOffset, endOffset });
    // An unresolved write leaves any skipped prefix pending from the durable checkpoint.
    const byteRange = { startOffset: Math.min(startOffset, batch.expectedOffset), endOffset };
    const winner = await readStorage(batch.source, () => this.storage.readCheckpoint(batch.source), byteRange);
    const reason = outcome === "conflict" ? "version-conflict" : "storage-unavailable";
    const pending = () => new ScanPendingError(reason, batch.source, byteRange);
    const offset = winner.checkpoint?.offset ?? 0;
    if (winner.version <= batch.expectedVersion || (!winner.checkpoint && previous)) throw pending();
    if (offset === this.lastRecoveryOffset && !sameCheckpoint(winner.checkpoint, batch.checkpoint)) throw pending();
    // A session version alone can explain a conflict, but cannot confirm a lost write on this source.
    if (sameCheckpoint(winner.checkpoint, previous)) {
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
    const offsets = checkpointPrefixes(checkpoint).map(prefix => prefix.offset);
    if (!offsets.length || offsets.some(end => end > this.transcript.fileSize)) return false;
    try {
      const verified = await this.transcript.prefixDigests(offsets);
      const digests = new Map(verified.map(({ offset, prefixDigest }) => [offset, prefixDigest]));
      return verifiedCheckpoint(checkpoint, digests);
    } catch (error) {
      if (error instanceof TranscriptChangedError) return false;
      throw error;
    }
  }
}
