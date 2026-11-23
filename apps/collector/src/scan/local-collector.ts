import { TranscriptChangedError, type ScanSelection, type TranscriptSource } from "../transcript/index.ts";
import {
  StorageAuthenticationError, type AcknowledgedSource, type Batch, type Checkpoint, type CheckpointSnapshot, type CollectorStorage,
  type MissingSource, type SessionView, type StreamKey,
} from "../storage/collector-storage.ts";
import { ScanRecovery, checkpointPrefixes, readStorage, verifiedCheckpoint, type ScanRestart } from "./scan-recovery.ts";
import { ScanRejectedError, type RejectedBatch } from "./scan-rejected.ts";
import { ScanPendingError } from "./scan-pending.ts";
import type { ScanProgress } from "./scan-progress.ts";
import type { EarlierCopies, ProviderScan, ScanProvider } from "./scan-provider.ts";
import { SourcePresenceScan, type RestoreCopy, type RestoredSource } from "./source-presence.ts";
import { sourceId, SourceSighting, SourceSightings } from "./source-sightings.ts";
import { TranscriptCursor, type ParserFormat, type SourceLine } from "./transcript-cursor.ts";

export { ScanPendingError, type PendingScan } from "./scan-pending.ts";
export { ScanRejectedError, type RejectedBatch } from "./scan-rejected.ts";
export type { MissingSource } from "../storage/collector-storage.ts";
export type { IdentityInventory, LocatedSource, ProviderScan, ScanProvider } from "./scan-provider.ts";
export type { ParserFormat, ProviderCheckpointFields, ReplacedCheckpointFields, SavedDecoder, UsageCorrection } from "./transcript-cursor.ts";
export type { ChatParser, DecodedChat } from "./decoded-chat.ts";

/** What the scanner receives. Only the providers and the storage are required. */
export interface LocalCollectorOptions {
  /** The scanner reads these providers in this order. */
  providers: readonly ScanProvider[];
  storage: CollectorStorage;
  /** The installation ID of the configuration. Without it, each stream ID is root-based. */
  installationId?: string;
  onRejection?: (report: RejectedBatch) => void;
  onMissing?: (report: MissingSource) => void;
  progress?: ScanProgress;
}

interface TranscriptResult {
  hasStoredSession: boolean;
  rejection?: RejectedBatch;
}

type SelectParser<Entry> = (source: TranscriptSource<Entry>, checkpoint: Checkpoint | null) => ParserFormat<Entry> | Promise<ParserFormat<Entry>>;
type SelectedSessions = Map<string, { source: StreamKey; required: boolean }>;

async function readCheckpoints(sightings: SourceSighting[], now: () => number): Promise<CheckpointSnapshot[]> {
  const results = await Promise.allSettled(sightings.map(s => readStorage(s.source, () => s.readCheckpoint()).catch(error => {
    if (error instanceof ScanPendingError) error.useClock(now());
    throw error;
  })));
  const snapshots: CheckpointSnapshot[] = [];
  let pending: ScanPendingError | undefined;
  const fatal = results.find(result => result.status === "rejected" && result.reason instanceof StorageAuthenticationError);
  if (fatal?.status === "rejected") throw fatal.reason;
  for (const result of results) {
    if (result.status === "fulfilled") snapshots.push(result.value);
    else if (!(result.reason instanceof ScanPendingError)) throw result.reason;
    else if (!pending || result.reason.pending.retryAt > pending.pending.retryAt) pending = result.reason;
  }
  if (pending) throw pending;
  return snapshots;
}

async function scanFiles<Entry extends SourceLine>(
  presence: SourcePresenceScan<Entry>, scan: ProviderScan<Entry>, importFile: (group: readonly TranscriptSource<Entry>[]) => Promise<void>,
): Promise<ScanPendingError[]> {
  const logical = (path: string) => scan.logicalName ? scan.logicalName(path) : path;
  const retry = new Map<string, string>();
  const affected = new Map<string, StreamKey>();
  const failed = new Map<string, string>();
  const run = async (path?: string) => {
    const target = path && logical(path);
    const onChanged = (error: TranscriptChangedError) => {
      const id = logical(error.sourceFile);
      if (target) failed.set(target, error.sourceFile);
      else retry.set(id, error.sourceFile);
      const key = presence.discardCapture(error.sourceFile);
      if (key) affected.set(id, key);
    };
    for await (const group of scan.discoverFiles({ sourceFile: path, onChanged })) {
      const id = logical(group[0].sourceFile);
      if (target ? id !== target || failed.has(id) : retry.has(id)) continue;
      try {
        await importFile(group);
      } catch (error) {
        if (!(error instanceof TranscriptChangedError)) throw error;
        onChanged(error);
        if (error.sourceFile !== group[0].sourceFile) onChanged(new TranscriptChangedError(group[0].sourceFile));
      }
    }
  };
  await run();
  for (const path of retry.values()) await run(path);
  return [...failed].map(([id, path]) => {
    const error = new ScanPendingError("source-changed", affected.get(id) ?? presence.scope);
    error.pending.sourceFile = path;
    return error;
  });
}

export class LocalCollector {
  private readonly providers: readonly ScanProvider[];
  private readonly storage: CollectorStorage;
  private readonly installationId?: string;
  private readonly onRejection?: (report: RejectedBatch) => void;
  private readonly progress?: ScanProgress;
  private readonly sightings: SourceSightings;

  constructor({ providers, storage, installationId, onRejection, onMissing, progress }: LocalCollectorOptions) {
    this.providers = providers;
    this.storage = storage;
    this.installationId = installationId;
    this.onRejection = onRejection;
    this.progress = progress;
    this.sightings = new SourceSightings(storage, onMissing);
  }

  scanOnce(selection: ScanSelection = {}): Promise<SessionView[]> { return this.scan(selection, true); }

  async scanForChanges(selection: ScanSelection = {}): Promise<void> { await this.scan(selection, false); }

  private async scan(selection: ScanSelection, returnViews: boolean): Promise<SessionView[]> {
    const { providers, installationId } = this;
    const passes = providers.map(provider => {
      const scan = provider.openScan(selection);
      return { scan, presence: new SourcePresenceScan({ ...selection, harness: provider.harness, root: provider.root, installationId }, scan, this.sightings) };
    });
    const rejections: RejectedBatch[] = [];
    const sessions: SessionView[] = [];
    const changing: ScanPendingError[] = [];
    try {
      const selected: SelectedSessions[] = [];
      for (const { scan, presence } of passes) selected.push(await this.scanProvider(presence, scan, rejections, changing));
      for (const [i, { scan, presence }] of passes.entries()) {
        const copies = scan.earlierCopies;
        sessions.push(...await this.views(presence, selected[i], returnViews,
          copies && ((known, copy) => this.importCopy(copies, known, copy, rejections))));
      }
      if (changing.length) throw changing[0];
    } catch (error) {
      if (!(error instanceof ScanPendingError)) throw error;
      let failure = error;
      if (error.pending.reason === "storage-unavailable") {
        let pending: StreamKey | undefined;
        for (const { presence } of passes) {
          // Each provider reports its own absences. Keep the pending source of the first provider that has one.
          const reported = await presence.reportWhileOffline();
          pending ??= reported;
        }
        if (error.pending.scope && pending) failure = new ScanPendingError("storage-unavailable", pending, undefined, error.retryAfterMs);
      }
      if (this.progress) failure.useClock(this.progress.now());
      throw failure;
    }
    if (rejections.length) throw new ScanRejectedError(sessions, rejections);
    return sessions;
  }

  private async scanProvider<Entry extends SourceLine>(
    presence: SourcePresenceScan<Entry>, scan: ProviderScan<Entry>, rejections: RejectedBatch[], changing: ScanPendingError[],
  ): Promise<SelectedSessions> {
    const selectParser: SelectParser<Entry> = (source, checkpoint) => scan.parserFor(source, checkpoint);
    const sessions: SelectedSessions = new Map();
    const rejectedStreams = new Set<string>();
    const pending = await scanFiles(presence, scan, async group => {
      const file = group[0];
      const end = await file.completeEnd();
      const sources = [];
      for (const transcript of group) {
        const sighting = await presence.capture(transcript, end);
        if (!rejectedStreams.has(sourceId(sighting.source))) sources.push({ transcript, sighting });
      }
      if (!sources.length) return;
      const snapshots = await readCheckpoints(sources.map(s => s.sighting), () => this.progress?.now() ?? Date.now());
      const prefixes = snapshots.flatMap(({ checkpoint }) => checkpointPrefixes(checkpoint));
      const offsets = new Set(prefixes.map(prefix => prefix.offset).filter(offset => offset <= file.fileSize));
      offsets.add(end);
      for (const { observedThrough } of snapshots) if (observedThrough && observedThrough.offset <= end) offsets.add(observedThrough.offset);
      const verified = await file.prefixDigests([...offsets]);
      const digests = new Map(verified.map(({ offset, prefixDigest }) => [offset, prefixDigest]));
      let stopped = false;
      for (const [i, { sighting, transcript }] of sources.entries()) {
        const { source } = sighting;
        sighting.observation.observedPrefixDigest = digests.get(end);
        const earlier = snapshots[i].observedThrough;
        const proof = earlier && digests.get(earlier.offset);
        if (earlier && proof) sighting.observation.checkedPrefix = { offset: earlier.offset, prefixDigest: proof };
        // After a rejection, other sessions in this file can still have data from earlier scans.
        const result: TranscriptResult = stopped ? { hasStoredSession: snapshots[i].version > 0 }
          : await this.importTranscript(sighting, transcript, selectParser, snapshots[i], digests);
        if (stopped) sighting.rejected = true;
        if (result.rejection) {
          stopped = true;
          rejectedStreams.add(sourceId(source));
          rejections.push(result.rejection);
          this.onRejection?.(result.rejection);
        }
        if (result.hasStoredSession || (stopped && !sessions.has(source.sessionId))) {
          sessions.set(source.sessionId, { source, required: result.hasStoredSession });
        }
      }
    });
    changing.push(...pending);
    return sessions;
  }

  private async views<Entry extends SourceLine>(presence: SourcePresenceScan<Entry>, sessions: SelectedSessions, returnViews: boolean, restore?: RestoreCopy<Entry>): Promise<SessionView[]> {
    for (const source of await presence.finish(restore)) sessions.set(source.sessionId, { source, required: true });
    if (!returnViews) return [];
    const views: SessionView[] = [];
    for (const { source, required } of sessions.values()) {
      const view = await readStorage(source, () => this.storage.readSession({ harness: source.harness, sessionId: source.sessionId }));
      if (view) views.push(view);
      else if (required) throw new Error(`Storage has no session for ${source.harness}/${source.sessionId} after scan`);
    }
    return views;
  }

  private async importCopy<Entry extends SourceLine>(copies: EarlierCopies<Entry, TranscriptSource<Entry>>, known: AcknowledgedSource,
    copy: TranscriptSource<Entry>, rejections: RejectedBatch[]): Promise<RestoredSource | "unknown" | undefined> {
    const recovery = copies.open(copy);
    const sighting = new SourceSighting(known.source, { location: known.location, observedEnd: await copy.completeEnd() }, this.storage);
    const checkpoint = () => readStorage(known.source, () => sighting.readCheckpoint());
    const start = await checkpoint();
    if (!start.checkpoint?.prefixDigest) return "unknown";
    const digests = await recovery.verify(start.checkpoint);
    if (!digests) return;
    const end = sighting.observation.observedEnd;
    const offsets = [end];
    const earlier = start.observedThrough;
    if (earlier && earlier.offset <= end) offsets.push(earlier.offset);
    const [observed, checked] = await copy.prefixDigests(offsets);
    sighting.observation.observedPrefixDigest = observed.prefixDigest;
    sighting.observation.checkedPrefix = checked;
    const result = await this.importTranscript(sighting, recovery.current(known.location),
      () => recovery.format(), start, digests);
    if (result.rejection) {
      rejections.push(result.rejection);
      this.onRejection?.(result.rejection);
      return "unknown";
    }
    return { sighting, verify: async version => {
      const snapshot = await checkpoint();
      return snapshot.version === version && !!await recovery.verify(snapshot.checkpoint);
    } };
  }

  private async importTranscript<Entry extends SourceLine>(
    sighting: SourceSighting, transcript: TranscriptSource<Entry>, selectParser: SelectParser<Entry>,
    start: CheckpointSnapshot, digests: ReadonlyMap<number, string>,
  ): Promise<TranscriptResult> {
    const { source } = sighting;
    const recovery = new ScanRecovery(sighting, transcript);
    let position: ScanRestart = start.checkpoint && !verifiedCheckpoint(start.checkpoint, digests) ? { ...start, reset: true } : start;
    if (!position.reset && start.checkpoint) sighting.verifyAt(start.version);
    for (;;) {
      const accepted = position.reset ? null : position.checkpoint;
      if (accepted && this.progress) await this.progress.verified(source, position, transcript);
      const format = await selectParser(transcript, accepted);
      const corrected = accepted && (await TranscriptCursor.repairEvidence(transcript, accepted, format)
        ?? await TranscriptCursor.reconcileUsage(transcript, accepted, format));
      if (corrected && accepted) {
        const batch = { ...corrected, source, expectedVersion: position.version, expectedOffset: accepted.offset };
        const outcome = await recovery.commit(batch, accepted, 0);
        if (outcome && "status" in outcome) return { hasStoredSession: true, rejection: outcome };
        position = outcome ?? { version: position.version + 1, checkpoint: corrected.checkpoint };
        continue;
      }
      const result = await this.importFrom(source, transcript, format, position, recovery);
      if ("hasStoredSession" in result) {
        if (!result.rejection) this.progress?.finishedSource(source);
        return result;
      }
      position = result;
    }
  }

  private async importFrom<Entry extends SourceLine>(
    source: StreamKey, transcript: TranscriptSource<Entry>, format: ParserFormat<Entry>,
    { checkpoint, version, reset }: ScanRestart, recovery: ScanRecovery,
  ): Promise<TranscriptResult | ScanRestart> {
    let previous = checkpoint;
    let expectedVersion = version;
    let resetFrom = reset ? checkpoint : null;
    let known = reset ? await readStorage(source, () => this.storage.readSession(source)) : undefined;
    const cursor = await TranscriptCursor.restore(transcript, checkpoint, format, reset ? known?.messages ?? [] : undefined);
    for await (const { chat, checkpoint: next, startOffset, upgrade } of cursor.read(transcript)) {
      const expectedOffset = previous?.offset ?? 0;
      if (format.prepareBatch) {
        if (known === undefined) known = await readStorage(source, () => this.storage.readSession(source));
        if (!format.prepareBatch(chat, known, expectedOffset)) continue;
      }
      const { claudeUsageReports, usageDiagnostics, ...records } = chat;
      const batch: Batch = {
        ...records, usage: chat.usage ?? [],
        source, expectedVersion, expectedOffset, checkpoint: next,
        ...(resetFrom && { resetFrom }),
        ...(upgrade && { upgradeFromParserState: checkpoint?.parserState }),
        ...(claudeUsageReports?.length && { claudeUsageReports }),
        ...(usageDiagnostics?.length && { usageDiagnostics }),
      };
      const outcome = await recovery.commit(batch, previous, startOffset);
      if (outcome && "status" in outcome) return { hasStoredSession: expectedVersion > 0, rejection: outcome };
      if (outcome) return outcome;
      resetFrom = null;
      previous = next;
      expectedVersion++;
    }
    return { hasStoredSession: (previous?.offset ?? 0) > 0 };
  }
}
