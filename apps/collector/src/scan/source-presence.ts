import { isDeepStrictEqual } from "node:util";
import type { TranscriptSource } from "../history/index.ts";
import { StorageBackoffError, StorageUnavailableError, type AcknowledgedSource, type CommitResult, type MissingSource, type PresenceWrite,
  type ObservedExtent, type SourceObservation, type SourceScope, type StreamKey } from "../storage/collector-storage.ts";
import { ScanPendingError } from "./scan-pending.ts";
import { assessClaudeCopies, unreadableCopy, type ClaudeBackup } from "./claude-source-copy.ts";
import { captureProof, readStorage } from "./scan-recovery.ts";
import { sourceId, SourceSighting, SourceSightings } from "./source-sightings.ts";
import { CodexIdentityRepair } from "./codex-identity-repair.ts";

interface SourceLocations<Entry> {
  identitiesAt?(paths: ReadonlySet<string>): AsyncIterable<{ path: string; sessionId: string }>;
  confirmedAbsent(paths: readonly string[], excludedCopyPaths?: readonly string[]): Promise<readonly string[]>;
  recoveryCandidates?(paths: ReadonlySet<string>): AsyncIterable<ClaudeBackup<Entry>>;
}

interface Seen<Entry> {
  sighting: SourceSighting;
  transcript: TranscriptSource<Entry>;
}

export interface RestoredSource {
  sighting: SourceSighting;
  verify(version: number): Promise<boolean>;
}
export type RestoreCopy<Entry> = (known: AcknowledgedSource, copy: TranscriptSource<Entry>) => Promise<RestoredSource | "unknown" | undefined>;

function reportFor({ source, acceptedOffset, observedEnd }: AcknowledgedSource): MissingSource {
  return { status: "missing", source, acceptedOffset, observedEnd };
}

function extentFor(row: AcknowledgedSource, local?: SourceSighting): ObservedExtent & Pick<SourceObservation, "checkedPrefix"> {
  const proof = local?.verified;
  const sameGeneration = proof && (proof.version === row.version
    || (row.generation !== undefined && row.generation <= proof.version && proof.version <= row.version));
  if (sameGeneration && (proof.extent.offset > row.observedEnd || (proof.extent.offset === row.observedEnd && !row.observedPrefixDigest))) {
    return { ...proof.extent, checkedPrefix: proof.checkedPrefix };
  }
  return { offset: row.observedEnd, prefixDigest: row.observedPrefixDigest };
}

function recordsSighting(known: AcknowledgedSource | undefined, observation: SourceObservation): boolean {
  if (!known || known.presence !== "present" || known.observedEnd < observation.observedEnd) return false;
  if (observation.observedEnd < known.observedEnd && known.observedEnd > known.acceptedOffset && !known.unrecovered) return false;
  const { location } = observation;
  // A stream may retain its earlier cwd if the current file supplies none.
  return isDeepStrictEqual(known.location, { ...known.location, ...location }) && location.currentFileCwd === known.location.currentFileCwd;
}

/** Compare an inventory snapshot with a subsequent search of every possible physical location. */
export class SourcePresenceScan<Entry> {
  private readonly seen = new Map<string, Seen<Entry>>();

  constructor(readonly scope: SourceScope, private readonly locations: SourceLocations<Entry>, private readonly memory: SourceSightings) {}

  async capture(transcript: TranscriptSource<Entry>, observedEnd: number): Promise<SourceSighting> {
    const sighting = await this.memory.capture(this.scope, transcript, observedEnd);
    const seen = { sighting, transcript };
    this.seen.set(sourceId(sighting.source), seen);
    return sighting;
  }

  discardCapture(path: string): StreamKey | undefined {
    let key: StreamKey | undefined;
    for (const [id, seen] of this.seen) if (seen.transcript.sourceFile === path) {
      this.seen.delete(id);
      key ??= seen.sighting.source;
    }
    return key;
  }

  private inventory(source?: StreamKey): Promise<AcknowledgedSource[]> {
    const scope = source ? { ...this.scope, sessionIds: [source.sessionId], projectPaths: [] } : this.scope;
    return readStorage(source ?? this.scope, () => this.memory.storage.listSources(scope));
  }

  async finish(restore?: RestoreCopy<Entry>): Promise<StreamKey[]> {
    const selected: StreamKey[] = [];
    const acknowledged = await this.inventory();
    const known = new Map(acknowledged.map(row => [sourceId(row.source), row]));
    const uncertain = new Map(this.memory.forScope(this.scope).map(item => [sourceId(item.source), item]));
    for (const [id, seen] of this.seen) {
      if (!seen.sighting.rejected) await this.present({ sighting: seen.sighting, verify: async version => {
        if (seen.sighting.verified?.version === version) {
          await seen.transcript.prefixDigests([]);
          return true;
        }
        const snapshot = await readStorage(seen.sighting.source, () => seen.sighting.readCheckpoint());
        return snapshot.version === version && !!await captureProof(seen.transcript, snapshot.checkpoint);
      } }, known.get(id));
      uncertain.delete(id);
      known.delete(id);
    }
    if (this.scope.harness === "codex" && known.size) {
      const repair = new CodexIdentityRepair(this.memory.storage, this.scope);
      selected.push(...await repair.reconcile(known, this.seen.values(), this.locations.identitiesAt?.bind(this.locations)));
    }
    const excluded = restore ? await this.restoreCopies(known, uncertain, restore, selected) : new Map<string, string[]>();
    const paths = new Set([...known.values()].map(row => row.location.path));
    for (const item of uncertain.values()) paths.add(item.observation.location.path);
    if (!paths.size) return selected;
    const absent = new Set(await this.locations.confirmedAbsent([...paths]));
    for (const [id, row] of known) {
      const local = uncertain.get(id);
      uncertain.delete(id);
      const rejectedCopies = excluded.get(id);
      if (!absent.has(row.location.path) && !(rejectedCopies?.length && (await this.locations.confirmedAbsent([row.location.path], rejectedCopies)).length)) {
        if (row.presence === "missing") selected.push(row.source);
        continue;
      }
      if (await this.missing(row, local, rejectedCopies)) selected.push(row.source);
      if (local) this.memory.forget(local);
    }
    for (const local of uncertain.values()) {
      if (!absent.has(local.observation.location.path)) continue;
      // A dropped first upload may have succeeded. Only storage can confirm a zero checkpoint.
      const snapshot = await readStorage(local.source, () => local.readCheckpoint());
      if (!snapshot.checkpoint) this.reportUnacknowledged(local);
    }
    return selected;
  }

  private async restoreCopies(known: Map<string, AcknowledgedSource>, uncertain: Map<string, SourceSighting>, restore: RestoreCopy<Entry>, selected: StreamKey[]) {
    const rejected = new Map<string, string[]>();
    const paths = new Set([...known.values()].map(row => row.location.path));
    if (!paths.size || !this.locations.recoveryCandidates) return rejected;
    const byPath = new Map<string, ClaudeBackup<Entry>[]>();
    for await (const copy of this.locations.recoveryCandidates(paths)) {
      const group = byPath.get(copy.currentPath) ?? [];
      group.push(copy);
      byPath.set(copy.currentPath, group);
    }
    for (const [id, initial] of known) {
      const copies = byPath.get(initial.location.path);
      if (!copies?.length) continue;
      let row = initial;
      const extent = extentFor(row, uncertain.get(id));
      if (extent.prefixDigest && (extent.offset > row.observedEnd || (!row.observedPrefixDigest && !row.unrecovered))) {
        // The original disappeared before its last upload. Save that generation's proof before a backup can advance the byte.
        const result = await this.write({ source: row.source, expectedVersion: row.version, expectedOffset: row.acceptedOffset,
          location: row.location, presence: row.presence, observedEnd: extent.offset, observedPrefixDigest: extent.prefixDigest,
          checkedPrefix: extent.checkedPrefix });
        const current = await this.reload(row.source);
        if (!current || (result !== "committed" && extentFor(current, uncertain.get(id)).offset > current.observedEnd)) {
          throw new ScanPendingError(result === "storage-unavailable" ? result : "version-conflict", row.source);
        }
        known.set(id, row = current);
      }
      const snapshot = await readStorage(row.source, () => this.memory.storage.readCheckpoint(row.source));
      const { excluded, candidates } = await assessClaudeCopies(row, snapshot.checkpoint, copies);
      for (const { transcript, path } of candidates) {
        if ([...this.seen.values()].some(s => s.sighting.rejected && s.transcript.sourceFile === transcript.sourceFile)) continue;
        try {
          const verified = await restore(row, transcript);
          if (verified === "unknown") continue;
          if (!verified) { excluded.push(path); continue; }
          if (await this.present(verified, await this.reload(row.source))) {
            selected.push(row.source);
            known.delete(id);
          }
          break;
        } catch (error) {
          if (!unreadableCopy(error)) throw error;
        }
      }
      rejected.set(id, excluded);
    }
    return rejected;
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

  private async missing(row: AcknowledgedSource, local?: SourceSighting, excluded?: readonly string[]): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      // A concurrent reset can reach the same accepted byte in a different transcript.
      const extent = extentFor(row, local);
      const end = extent.offset;
      const report = reportFor(row);
      if (row.presence === "missing" && end <= row.observedEnd) {
        this.memory.confirmReply(report);
        return true;
      }
      report.observedEnd = Math.max(row.observedEnd, end);
      const result = await this.write({ source: row.source, expectedOffset: row.acceptedOffset, expectedVersion: row.version,
        presence: "missing", location: row.location, observedEnd: report.observedEnd, observedPrefixDigest: extent.prefixDigest,
        checkedPrefix: extent.checkedPrefix }, row.presence === "missing" ? undefined : report);
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
      if (!(await this.locations.confirmedAbsent([current.location.path], excluded)).length) return false;
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
