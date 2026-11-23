import {
  StorageUnavailableError, StreamKeys, type AcknowledgedSource, type Batch, type Checkpoint, type CheckpointSnapshot, type CollectorStorage,
  type PresenceWrite, type SessionKey, type SourceLocation, type SourceScope, type StreamKey,
} from "../storage/collector-storage.ts";
import { CheckpointProof } from "../scan/checkpoint-proof.ts";
import { ParserState } from "../scan/parser-state.ts";
import type { PendingScan } from "../scan/scan-pending.ts";
import type { PrefixReader, ScanProgress } from "../scan/scan-progress.ts";
import { ScanRecovery } from "../scan/scan-recovery.ts";

export type ScheduledScanOutcome = { status: "complete" | "rejected" | "failed"; retryAt?: never }
  | { status: "pending"; retryAt: string };

export type ScheduledScanReport = ScheduledScanOutcome & {
  newSessions: number;
  oldestPendingAgeMs: number | null;
};

interface OutstandingSource {
  since: number;
  awaitingCheckpoint?: boolean;
  through?: number;
  write?: { checkpoint: Checkpoint; version: number; previousOffset: number; lostReply: boolean };
}

/** Count accepted sessions and retain only work whose storage outcome is still outstanding. */
export class ScanActivity implements CollectorStorage, ScanProgress {
  private readonly sources = new Map<string, OutstandingSource>();
  private readonly inventories = new Map<string, number>();
  private readonly unknownFirstWrites = new Map<string, { id: string; checkpoint: Checkpoint }>();
  private readonly created = new Set<string>();
  private readonly rechecked = new Set<string>();
  private failedInventory?: { id: string; since: number };
  private changingFile?: { path: string; since: number };

  constructor(private readonly storage: CollectorStorage, readonly now: () => number = Date.now) {}

  resolveSource(source: StreamKey, location: SourceLocation, verify: (checkpoint: Checkpoint) => Promise<boolean>) {
    return this.storage.resolveSource?.(source, location, verify) ?? Promise.resolve(source);
  }

  beginPass(): void {
    this.created.clear();
    this.rechecked.clear();
    this.failedInventory = undefined;
  }

  finishPass(outcome: ScheduledScanOutcome): ScheduledScanReport {
    if (outcome.status === "complete" || outcome.status === "rejected") {
      this.changingFile = undefined;
      for (const id of this.rechecked) {
        if (this.sources.get(id)?.through === undefined) this.sources.delete(id);
      }
    }
    let oldest = this.changingFile?.since ?? Infinity;
    for (const { since } of this.sources.values()) oldest = Math.min(oldest, since);
    for (const since of this.inventories.values()) oldest = Math.min(oldest, since);
    const oldestPendingAgeMs = oldest === Infinity ? null : Math.max(0, this.now() - oldest);
    return { ...outcome, newSessions: this.created.size, oldestPendingAgeMs };
  }

  pending(report: PendingScan): void {
    if (report.reason === "source-changed" && report.sourceFile) {
      if (this.changingFile?.path !== report.sourceFile) this.changingFile = { path: report.sourceFile, since: this.now() };
    } else if (report.source) {
      this.hold(report.source, this.now(), { through: report.byteRange?.endOffset });
    } else {
      const id = ScanActivity.scopeId(report.scope);
      const since = this.failedInventory?.id === id ? this.failedInventory.since : this.now();
      if (!this.inventories.has(id)) this.inventories.set(id, since);
    }
  }

  async listSources(scope: SourceScope) {
    const id = ScanActivity.scopeId(scope);
    const start = this.now();
    let rows: AcknowledgedSource[];
    try {
      rows = await this.storage.listSources(scope);
    } catch (error) {
      // A failed reload for one source is reported against that source by the scanner.
      if (StorageUnavailableError.is(error)) this.failedInventory = { id, since: start };
      throw error;
    }
    this.inventories.delete(id);
    for (const row of rows) {
      const stream = StreamKeys.sourceId(row.source);
      const write = this.sources.get(stream)?.write;
      // A file can vanish before a lost reply is confirmed. Its inventory has the byte,
      // but only the stored checkpoint can identify the attempted write at that byte.
      if (write?.lostReply && !this.rechecked.has(stream) && row.version > write.version && row.acceptedOffset === write.checkpoint.offset) {
        await ScanRecovery.read(row.source, () => this.readCheckpoint(row.source));
      }
      this.checked(row.source);
    }
    return rows;
  }

  async readCheckpoint(source: StreamKey) {
    const start = this.now();
    try {
      const snapshot = await this.storage.readCheckpoint(source);
      this.confirmStored(source, snapshot);
      this.checked(source);
      return snapshot;
    } catch (error) {
      if (StorageUnavailableError.is(error)) this.hold(source, start, { awaitingCheckpoint: true });
      throw error;
    }
  }

  readSession(key: SessionKey) {
    return this.storage.readSession(key);
  }

  async recordPresence(update: PresenceWrite) {
    const result = await this.storage.recordPresence(update);
    if (result === "committed") this.checked(update.source);
    return result;
  }

  async commit(batch: Batch) {
    const start = this.now();
    try {
      const result = await this.storage.commit(batch);
      if (result === "committed") {
        if (batch.expectedVersion === 0) this.countCreation(batch.source);
        this.accepted(batch.source, batch.checkpoint.offset, batch.sourceObservation?.observedEnd);
      } else {
        this.unconfirmed(batch, start, false);
      }
      return result;
    } catch (error) {
      if (StorageUnavailableError.is(error)) {
        this.unconfirmed(batch, start, true);
      }
      throw error;
    }
  }

  /** The scanner has matched the durable checkpoint to this capture. For a later winner,
   * also check the captured prefix through the outstanding write's own end. */
  async verified(source: StreamKey, { version, checkpoint }: CheckpointSnapshot, transcript?: PrefixReader): Promise<void> {
    const id = StreamKeys.sourceId(source);
    const work = this.sources.get(id);
    if (!checkpoint || work?.through === undefined || checkpoint.offset < work.through) return;
    const { write } = work;
    if (write) {
      if (version <= write.version) return;
      if (checkpoint.offset === write.checkpoint.offset) {
        if (!CheckpointProof.same(write.checkpoint, ScanActivity.checkpointStamp(checkpoint))) return;
      } else {
        const { offset, prefixDigest } = write.checkpoint;
        if (!transcript || offset <= write.previousOffset || !prefixDigest) return;
        const prefixes = await transcript.prefixDigests([offset]);
        if (!prefixes.some(prefix => prefix.offset === offset && prefix.prefixDigest === prefixDigest)) return;
      }
    }
    const first = this.unknownFirstWrites.get(StreamKeys.session(source));
    if (first?.id === id && write && CheckpointProof.same(first.checkpoint, write.checkpoint)) this.countCreation(source);
    this.accepted(source, checkpoint.offset);
  }

  finishedSource(source: StreamKey): void {
    const id = StreamKeys.sourceId(source);
    const work = this.sources.get(id);
    if (work?.awaitingCheckpoint && work.through === undefined) this.sources.delete(id);
  }

  private confirmStored(source: StreamKey, { version, checkpoint }: CheckpointSnapshot): void {
    const id = StreamKeys.sourceId(source);
    const key = StreamKeys.session(source);
    const first = this.unknownFirstWrites.get(key);
    const write = this.sources.get(id)?.write;
    if (version === 0 || (!write?.lostReply && first?.id !== id)) return;
    if (!checkpoint) {
      // Another stream created the session before this first request reached storage.
      if (first?.id === id) this.unknownFirstWrites.delete(key);
      return;
    }
    const stamp = ScanActivity.checkpointStamp(checkpoint);
    if (first?.id === id && CheckpointProof.same(first.checkpoint, stamp)) this.countCreation(source);
    if (write?.lostReply && version > write.version && CheckpointProof.same(write.checkpoint, stamp)) this.accepted(source, checkpoint.offset);
  }

  private hold(
    source: StreamKey, since: number, { through, awaitingCheckpoint }: Pick<OutstandingSource, "through" | "awaitingCheckpoint">,
  ): OutstandingSource {
    const id = StreamKeys.sourceId(source);
    this.rechecked.delete(id);
    const work = this.sources.get(id) ?? { since, awaitingCheckpoint };
    if (through !== undefined) work.through = Math.max(through, work.through ?? 0);
    this.sources.set(id, work);
    return work;
  }

  private unconfirmed(batch: Batch, since: number, lostReply: boolean): void {
    const work = this.hold(batch.source, since, { through: batch.checkpoint.offset });
    if (batch.checkpoint.offset === batch.sourceObservation?.observedEnd) work.through = batch.checkpoint.offset;
    const stamp = ScanActivity.checkpointStamp(batch.checkpoint);
    if (work.through === batch.checkpoint.offset) {
      work.write = { checkpoint: stamp, version: batch.expectedVersion, previousOffset: batch.expectedOffset, lostReply };
    }
    if (lostReply && batch.expectedVersion === 0) {
      this.unknownFirstWrites.set(StreamKeys.session(batch.source), { id: StreamKeys.sourceId(batch.source), checkpoint: stamp });
    }
  }

  private checked(source: StreamKey): void {
    const id = StreamKeys.sourceId(source);
    if (this.sources.has(id)) this.rechecked.add(id);
  }

  private countCreation(source: StreamKey): void {
    const key = StreamKeys.session(source);
    this.unknownFirstWrites.delete(key);
    this.created.add(key);
  }

  private accepted(source: StreamKey, offset: number, completeEnd?: number): void {
    const id = StreamKeys.sourceId(source);
    const pending = this.sources.get(id);
    // A repaired or replaced file can be shorter than the previously rejected batch.
    if (!pending || (offset < (pending.through ?? 0) && offset !== completeEnd)) return;
    this.sources.delete(id);
    const key = StreamKeys.session(source);
    if (this.unknownFirstWrites.get(key)?.id === id) this.unknownFirstWrites.delete(key);
  }

  private static scopeId(scope: SourceScope): string {
    return JSON.stringify([scope.harness, scope.installationId, scope.root,
      [...new Set(scope.sessionIds)].sort(), [...new Set(scope.projectPaths)].sort()]);
  }

  /** Retain a fingerprint of a failed write instead of keeping its decoder or conversation in memory. */
  private static checkpointStamp(checkpoint: Checkpoint): Checkpoint {
    return { ...checkpoint, parserState: ParserState.digest(checkpoint.parserState) };
  }
}
