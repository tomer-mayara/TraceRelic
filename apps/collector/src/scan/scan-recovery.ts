import { TranscriptChangedError, type TranscriptSource, type VerifiedPrefix } from "../history/index.ts";
import {
  type Batch, type ByteRange, type Checkpoint, type CheckpointSnapshot, type CollectorStorage, type CommitResult,
  type StreamKey, StorageUnavailableError,
} from "../storage/collector-storage.ts";
import { ScanPendingError } from "./scan-pending.ts";

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
  return checkpoint.replayThrough ? [accepted, checkpoint.replayThrough] : [accepted];
}

export function verifiedCheckpoint(checkpoint: Checkpoint, digests: ReadonlyMap<number, string>): boolean {
  return !!checkpoint.prefixDigest && checkpointPrefixes(checkpoint).every(prefix => digests.get(prefix.offset) === prefix.prefixDigest);
}

function sameCheckpoint(left: Checkpoint | null, right: Checkpoint | null): boolean {
  return left?.offset === right?.offset && left?.prefixDigest === right?.prefixDigest && left?.parserState === right?.parserState
    && left?.replayThrough?.offset === right?.replayThrough?.offset && left?.replayThrough?.prefixDigest === right?.replayThrough?.prefixDigest;
}

export interface ScanRestart extends CheckpointSnapshot {
  reset?: true;
}

export class ScanRecovery {
  private lastRecoveryOffset = -1;

  constructor(
    private readonly storage: CollectorStorage,
    private readonly transcript: Pick<TranscriptSource<unknown>, "sourceFile" | "fileSize" | "prefixDigests">,
  ) {}

  /** Return the durable starting point when the interrupted cursor must be discarded. */
  async commit(batch: Batch, previous: Checkpoint | null, startOffset: number): Promise<ScanRestart | undefined> {
    let outcome: CommitResult | "storage-unavailable";
    try {
      outcome = await this.storage.commit(batch);
    } catch (error) {
      if (!StorageUnavailableError.is(error)) throw error;
      outcome = "storage-unavailable";
    }
    if (outcome === "committed") return;
    const byteRange = { startOffset, endOffset: batch.checkpoint.offset };
    if (outcome === "invalid") {
      throw new Error(`Storage returned invalid for ${this.transcript.sourceFile}, bytes ${byteRange.startOffset}..${byteRange.endOffset}`);
    }
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
