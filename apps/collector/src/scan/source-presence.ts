import { isDeepStrictEqual } from "node:util";
import type { TranscriptSource } from "../history/index.ts";
import { StorageBackoffError, StorageUnavailableError, type AcknowledgedSource, type CommitResult, type MissingSource, type PresenceWrite,
  type SourceObservation, type SourceScope, type StreamKey } from "../storage/collector-storage.ts";
import { ScanPendingError } from "./scan-pending.ts";
import { readStorage } from "./scan-recovery.ts";
import { sourceId, SourceSighting, SourceSightings } from "./source-sightings.ts";

interface SourceLocations {
  confirmedAbsent(paths: readonly string[]): Promise<readonly string[]>;
}

interface Seen<Entry> {
  sighting: SourceSighting;
  transcript: TranscriptSource<Entry>;
}

export interface RestoredSource {
  sighting: SourceSighting;
  verify(version: number): Promise<boolean>;
}
export type RestoreCopy<Entry> = (known: AcknowledgedSource, copy: TranscriptSource<Entry>) => Promise<RestoredSource | undefined>;

function reportFor({ source, acceptedOffset, observedEnd }: AcknowledgedSource): MissingSource {
  return { status: "missing", source, acceptedOffset, observedEnd };
}

function recordsSighting(known: AcknowledgedSource | undefined, observation: SourceObservation): boolean {
  if (!known || known.presence !== "present" || known.observedEnd < observation.observedEnd) return false;
  const { location } = observation;
  // A stream may retain its earlier cwd if the current file supplies none.
  return isDeepStrictEqual(known.location, { ...known.location, ...location }) && location.currentFileCwd === known.location.currentFileCwd;
}

/** Compare an inventory snapshot with a subsequent search of every possible physical location. */
export class SourcePresenceScan<Entry> {
  private readonly seen = new Map<string, Seen<Entry>>();
  private readonly copies = new Map<string, Seen<Entry>[]>();

  constructor(readonly scope: SourceScope, private readonly locations: SourceLocations, private readonly memory: SourceSightings) {}

  capture(transcript: TranscriptSource<Entry>, observedEnd: number): SourceSighting {
    const sighting = this.memory.capture(this.scope, transcript, observedEnd);
    const seen = { sighting, transcript };
    this.seen.set(sourceId(sighting.source), seen);
    if (transcript.currentFilePath) {
      const key = JSON.stringify([transcript.sessionId, transcript.currentFilePath]);
      const copies = this.copies.get(key) ?? [];
      copies.push(seen);
      this.copies.set(key, copies);
    }
    return sighting;
  }

  private inventory(source?: StreamKey): Promise<AcknowledgedSource[]> {
    const scope = source ? { ...this.scope, sessionIds: [source.sessionId], projectPaths: [] } : this.scope;
    return readStorage(source ?? this.scope, () => this.memory.storage.listSources(scope));
  }

  async finish(restore?: RestoreCopy<Entry>): Promise<StreamKey[]> {
    const acknowledged = await this.inventory();
    const known = new Map(acknowledged.map(row => [sourceId(row.source), row]));
    const uncertain = new Map(this.memory.forScope(this.scope).map(item => [sourceId(item.source), item]));
    for (const [id, seen] of this.seen) {
      if (!seen.sighting.rejected) await this.present({ sighting: seen.sighting, verify: async () => {
        await seen.transcript.prefixDigests([]);
        return true;
      } }, known.get(id));
      uncertain.delete(id);
      known.delete(id);
    }
    if (restore) await this.restoreCopies(known, restore);
    const paths = new Set([...known.values()].map(row => row.location.path));
    for (const item of uncertain.values()) paths.add(item.observation.location.path);
    if (!paths.size) return [];
    const absent = new Set(await this.locations.confirmedAbsent([...paths]));
    const missing: StreamKey[] = [];
    for (const [id, row] of known) {
      const local = uncertain.get(id);
      uncertain.delete(id);
      if (!absent.has(row.location.path)) continue;
      if (await this.missing(row, local)) missing.push(row.source);
      if (local) this.memory.forget(local);
    }
    for (const local of uncertain.values()) {
      if (!absent.has(local.observation.location.path)) continue;
      // A dropped first upload may have succeeded. Only storage can confirm a zero checkpoint.
      const snapshot = await readStorage(local.source, () => local.readCheckpoint());
      if (!snapshot.checkpoint) this.reportUnacknowledged(local);
    }
    return missing;
  }

  private async restoreCopies(known: Map<string, AcknowledgedSource>, restore: RestoreCopy<Entry>): Promise<void> {
    for (const [id, row] of known) {
      if (row.presence === "present" && row.observedEnd <= row.acceptedOffset) continue;
      const copies = this.copies.get(JSON.stringify([row.source.sessionId, row.location.path])) ?? [];
      copies.sort((a, b) => b.sighting.observation.observedEnd - a.sighting.observation.observedEnd);
      for (const { sighting, transcript } of copies) {
        if (sighting.rejected) continue;
        const verified = await restore(row, transcript);
        if (!verified) continue;
        if (await this.present(verified, await this.reload(row.source))) known.delete(id);
        break;
      }
    }
  }

  async reportWhileOffline(): Promise<StreamKey | undefined> {
    const candidates = this.memory.forScope(this.scope).filter(item => !this.seen.has(sourceId(item.source)));
    if (!candidates.length) return;
    const absent = new Set(await this.locations.confirmedAbsent(candidates.map(item => item.observation.location.path)));
    let pending: StreamKey | undefined;
    for (const item of candidates) {
      if (!absent.has(item.observation.location.path)) continue;
      if (item.confirmed?.checkpoint === null) this.reportUnacknowledged(item);
      else pending ??= item.source;
    }
    return pending;
  }

  private reportUnacknowledged(item: SourceSighting): void {
    this.memory.forget(item);
    this.memory.onMissing?.({ status: "missing", source: item.source, acceptedOffset: 0, observedEnd: item.observation.observedEnd });
  }

  private async present(seen: RestoredSource, known?: AcknowledgedSource): Promise<boolean> {
    const { sighting } = seen;
    const { observation, source, confirmed } = sighting;
    for (let attempt = 0; !recordsSighting(known, observation); attempt++) {
      const expectedOffset = known?.acceptedOffset ?? confirmed?.checkpoint?.offset;
      const expectedVersion = known?.version ?? confirmed?.version;
      if (expectedOffset === undefined || expectedVersion === undefined) break;
      // Verify again after a conflict. A newer version can describe a different generation or a new disappearance.
      if (!await seen.verify(expectedVersion)) return false;
      const result = await this.write({ ...observation, observedEnd: Math.max(expectedOffset, observation.observedEnd),
        source, expectedOffset, expectedVersion, presence: "present" });
      if (result === "committed") break;
      known = await this.reload(source);
      if (recordsSighting(known, observation)) break;
      if (!known || result === "storage-unavailable" || attempt > 0) throw new ScanPendingError(result, source);
    }
    this.memory.discardReply(source);
    this.memory.forget(sighting);
    return true;
  }

  private async missing(row: AcknowledgedSource, local?: SourceSighting): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      // A concurrent reset can reach the same accepted byte in a different transcript.
      const end = local?.verifiedVersion === row.version ? Math.max(row.observedEnd, local.observation.observedEnd) : row.observedEnd;
      const report = reportFor(row);
      if (row.presence === "missing" && end <= row.observedEnd) {
        this.memory.confirmReply(report);
        return true;
      }
      report.observedEnd = Math.max(row.observedEnd, end);
      const result = await this.write({ source: row.source, expectedOffset: row.acceptedOffset, expectedVersion: row.version,
        presence: "missing", location: row.location, observedEnd: report.observedEnd }, row.presence === "missing" ? undefined : report);
      if (result === "committed") {
        this.memory.discardReply(row.source);
        if (row.presence !== "missing") this.memory.onMissing?.(report);
        return true;
      }
      const current = await this.reload(row.source);
      if (!current) throw new ScanPendingError(result, row.source);
      if (current.presence === "missing" && current.observedEnd >= report.observedEnd) {
        this.memory.confirmReply(reportFor(current));
        return true;
      }
      if (result === "storage-unavailable" || attempt > 0) throw new ScanPendingError(result, row.source);
      if (!(await this.locations.confirmedAbsent([current.location.path])).length) return false;
      row = current;
    }
    return false;
  }

  private async reload(source: StreamKey): Promise<AcknowledgedSource | undefined> {
    const id = sourceId(source);
    return (await this.inventory(source)).find(row => sourceId(row.source) === id);
  }

  private async write(update: PresenceWrite, missing?: MissingSource): Promise<"committed" | "version-conflict" | "storage-unavailable"> {
    let result: CommitResult;
    try {
      result = await this.memory.storage.recordPresence(update);
    } catch (error) {
      if (!StorageUnavailableError.is(error)) throw error;
      if (missing) this.memory.rememberReply(missing);
      if (error instanceof StorageBackoffError) throw new ScanPendingError("storage-unavailable", update.source, undefined, error.retryAfterMs);
      return "storage-unavailable";
    }
    if (result === "invalid") throw new Error(`Storage rejected source presence for ${update.source.streamId}`);
    return result === "conflict" ? "version-conflict" : result;
  }
}
