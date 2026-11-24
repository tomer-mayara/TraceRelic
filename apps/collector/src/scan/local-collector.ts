import type { GlobalConfig } from "../config/global-config.ts";
import { claudeCopyFallbackFields } from "@tracerelic/shared";
import { CodexRolloutFiles } from "../providers/codex/codex-rollout-files.ts";
import { ClaudeHistory, CodexHistory, type ClaudeTranscriptEntry, type CodexRolloutEntry } from "../providers/index.ts";
import { TranscriptChangedError, type ScanSelection, type TranscriptSource } from "../transcript/index.ts";
import {
  StorageAuthenticationError, type AcknowledgedSource, type Batch, type Checkpoint, type CheckpointSnapshot, type CollectorStorage,
  type Harness, type MissingSource, type SessionView, type StreamKey,
} from "../storage/collector-storage.ts";
import { ClaudeSourceCopy } from "../providers/claude/claude-source-copy.ts";
import { ClaudeSessionParser } from "../providers/claude/claude-session-parser.ts";
import { CodexForkSources } from "../providers/codex/codex-fork-sources.ts";
import type { DecodedChat } from "./decoded-chat.ts";
import type { ScanProgress } from "../watch/scan-activity.ts";
import { ScanRecovery, checkpointPrefixes, readStorage, verifiedCheckpoint, type ScanRestart } from "./scan-recovery.ts";
import { ScanRejectedError, type RejectedBatch } from "./scan-rejected.ts";
import { ScanPendingError } from "./scan-pending.ts";
import { SourcePresenceScan, type RestoreCopy, type RestoredSource } from "./source-presence.ts";
import { sourceId, SourceSighting, SourceSightings } from "./source-sightings.ts";
import { TranscriptCursor, type ParserFormat, type SourceLine } from "./transcript-cursor.ts";

export { ScanPendingError, type PendingScan } from "./scan-pending.ts";
export { ScanRejectedError, type RejectedBatch } from "./scan-rejected.ts";
export type { MissingSource } from "../storage/collector-storage.ts";

interface TranscriptResult {
  hasStoredSession: boolean;
  rejection?: RejectedBatch;
}

type SelectParser<Entry> = (source: TranscriptSource<Entry>, checkpoint: Checkpoint | null) => ParserFormat<Entry> | Promise<ParserFormat<Entry>>;
type SelectedSessions = Map<string, { source: StreamKey; required: boolean }>;
type SourceDiscovery = { sourceFile?: string; onChanged: (error: TranscriptChangedError) => void };
type Discover<Entry> = (options: SourceDiscovery) => AsyncIterable<TranscriptSource<Entry>>;

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

function preparePreviousCopy(chat: DecodedChat, known: SessionView | null, offset: number): boolean {
  if (!offset && !known && !chat.messages.length && !Object.keys(chat.metadata).length
    && !chat.claudeUsageReports?.length && !chat.usageDiagnostics?.length) return false;
  // Earlier copies can fill missing fields. Storage compares branches by their recorded positions.
  for (const field of claudeCopyFallbackFields) {
    if (known?.metadata[field] !== undefined) delete chat.metadata[field];
  }
  return true;
}

async function* files<Entry>(harness: Harness, transcripts: AsyncIterable<TranscriptSource<Entry>>) {
  let group: TranscriptSource<Entry>[] = [];
  for await (const source of transcripts) {
    if (harness === "codex") {
      yield [source];
      continue;
    }
    // Claude discovery emits all the selected sessions in a physical file together.
    if (group.length && group[0].sourceFile !== source.sourceFile) {
      yield group;
      group = [];
    }
    group.push(source);
  }
  if (group.length) yield group;
}

async function scanFiles<Entry>(
  presence: SourcePresenceScan<Entry>, discover: Discover<Entry>, importFile: (group: TranscriptSource<Entry>[]) => Promise<void>,
): Promise<ScanPendingError[]> {
  const logical = (path: string) => presence.scope.harness === "codex" ? CodexRolloutFiles.logicalName(path) : path;
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
    for await (const group of files(presence.scope.harness, discover({ sourceFile: path, onChanged }))) {
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
  private readonly sightings: SourceSightings;

  constructor(
    private readonly config: GlobalConfig, private readonly storage: CollectorStorage,
    private readonly onRejection?: (report: RejectedBatch) => void,
    onMissing?: (report: MissingSource) => void,
    private readonly progress?: ScanProgress,
  ) { this.sightings = new SourceSightings(storage, onMissing); }

  scanOnce(selection: ScanSelection = {}): Promise<SessionView[]> { return this.scan(selection, true); }

  async scanForChanges(selection: ScanSelection = {}): Promise<void> { await this.scan(selection, false); }

  private async scan(selection: ScanSelection, returnViews: boolean): Promise<SessionView[]> {
    const { codexPath, claudePath, installationId } = this.config;
    const codex = new CodexHistory(codexPath);
    const claude = claudePath ? new ClaudeHistory(claudePath) : undefined;
    const codexPresence = new SourcePresenceScan<CodexRolloutEntry>({ ...selection, harness: "codex", root: codexPath, installationId }, codex, this.sightings);
    const claudePresence = claudePath && claude && new SourcePresenceScan<ClaudeTranscriptEntry>({ ...selection, harness: "claude", root: claudePath, installationId }, claude, this.sightings);
    const rejections: RejectedBatch[] = [];
    const sessions: SessionView[] = [];
    const changing: ScanPendingError[] = [];
    try {
      let sources: CodexForkSources;
      const selected = await this.scanProvider(codexPresence, options => {
        const related = options.sourceFile ? () => codex.discoverSources(selection, { onChanged: options.onChanged }) : undefined;
        sources = new CodexForkSources(codex.discoverSources(selection, options), related);
        return sources.sources();
      }, (source, checkpoint) => sources.format(source, checkpoint), rejections, changing);
      const selectedClaude = claudePresence && claude && await this.scanProvider(claudePresence, options => claude.discoverSources(selection, options),
        source => ClaudeSessionParser.forSource(source.previousCopy, source.claudeSubagent), rejections, changing);
      sessions.push(...await this.views(codexPresence, selected, returnViews));
      if (claudePresence && selectedClaude) sessions.push(...await this.views(claudePresence, selectedClaude, returnViews,
        (known, copy) => this.importClaudeCopy(known, copy, rejections)));
      if (changing.length) throw changing[0];
    } catch (error) {
      if (!(error instanceof ScanPendingError)) throw error;
      let failure = error;
      if (error.pending.reason === "storage-unavailable") {
        const codexPending = await codexPresence.reportWhileOffline();
        const claudePending = claudePresence ? await claudePresence.reportWhileOffline() : undefined;
        const pending = codexPending ?? claudePending;
        if (error.pending.scope && pending) failure = new ScanPendingError("storage-unavailable", pending, undefined, error.retryAfterMs);
      }
      if (this.progress) failure.useClock(this.progress.now());
      throw failure;
    }
    if (rejections.length) throw new ScanRejectedError(sessions, rejections);
    return sessions;
  }

  private async scanProvider<Entry extends SourceLine>(
    presence: SourcePresenceScan<Entry>, discover: Discover<Entry>,
    selectParser: SelectParser<Entry>, rejections: RejectedBatch[], changing: ScanPendingError[],
  ): Promise<SelectedSessions> {
    const sessions: SelectedSessions = new Map();
    const rejectedStreams = new Set<string>();
    const pending = await scanFiles(presence, discover, async group => {
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

  private async views<Entry>(presence: SourcePresenceScan<Entry>, sessions: SelectedSessions, returnViews: boolean, restore?: RestoreCopy<Entry>): Promise<SessionView[]> {
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

  private async importClaudeCopy(known: AcknowledgedSource, copy: TranscriptSource<ClaudeTranscriptEntry>,
    rejections: RejectedBatch[]): Promise<RestoredSource | "unknown" | undefined> {
    const recovery = new ClaudeSourceCopy(copy);
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
      () => ClaudeSessionParser.forSource(false, copy.claudeSubagent), start, digests);
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
      if (transcript.previousCopy) {
        if (known === undefined) known = await readStorage(source, () => this.storage.readSession(source));
        if (!preparePreviousCopy(chat, known, expectedOffset)) continue;
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
