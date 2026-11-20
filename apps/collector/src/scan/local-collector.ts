import type { GlobalConfig } from "../config/global-config.ts";
import {
  LocalLLMHistoryClaude, LocalLLMHistoryCodex, type ClaudeTranscriptEntry, type CodexRolloutEntry, type ScanSelection, type TranscriptSource,
} from "../history/index.ts";
import type { AcknowledgedSource, Batch, Checkpoint, CheckpointSnapshot, CollectorStorage, Harness, MissingSource, SessionView, StreamKey } from "../storage/collector-storage.ts";
import { ClaudeSourceCopy } from "./claude-source-copy.ts";
import { ClaudeSessionParser } from "./claude-session-parser.ts";
import { CodexForkSources } from "./codex-fork-sources.ts";
import type { DecodedChat } from "./decoded-chat.ts";
import type { ScanProgress } from "./scan-activity.ts";
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

function preparePreviousCopy(chat: DecodedChat, known: SessionView | null, offset: number): boolean {
  if (!offset && !known && !chat.messages.length && !Object.keys(chat.metadata).length
    && !chat.claudeUsageReports?.length && !chat.usageDiagnostics?.length) return false;
  // Earlier copies can fill missing fields. Storage compares branches by their recorded positions.
  for (const field of ["cwd", "repository", "parentSessionId"] as const) {
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

export class LocalCollector {
  private readonly sightings: SourceSightings;

  constructor(
    private readonly config: GlobalConfig, private readonly storage: CollectorStorage,
    private readonly onRejection?: (report: RejectedBatch) => void,
    onMissing?: (report: MissingSource) => void,
    private readonly progress?: ScanProgress,
  ) { this.sightings = new SourceSightings(storage, onMissing); }

  async scanOnce(selection: ScanSelection = {}): Promise<SessionView[]> {
    const { codexPath, claudePath, installationId } = this.config;
    const codex = new LocalLLMHistoryCodex(this.config);
    const claude = new LocalLLMHistoryClaude(this.config);
    const codexPresence = new SourcePresenceScan<CodexRolloutEntry>({ ...selection, harness: "codex", root: codexPath, installationId }, codex, this.sightings);
    const claudePresence = claudePath && new SourcePresenceScan<ClaudeTranscriptEntry>({ ...selection, harness: "claude", root: claudePath, installationId }, claude, this.sightings);
    const rejections: RejectedBatch[] = [];
    const sessions: SessionView[] = [];
    try {
      const sources = new CodexForkSources(codex.discoverSources(selection));
      const selected = await this.scanProvider(codexPresence, sources.sources(), (source, checkpoint) => sources.format(source, checkpoint), rejections);
      const selectedClaude = claudePresence && await this.scanProvider(claudePresence, claude.discoverSources(selection),
        source => ClaudeSessionParser.forSource(source.previousCopy, source.claudeSubagent), rejections);
      sessions.push(...await this.views(codexPresence, selected));
      if (claudePresence && selectedClaude) sessions.push(...await this.views(claudePresence, selectedClaude,
        (known, copy) => this.importClaudeCopy(known, copy, rejections)));
    } catch (error) {
      if (!(error instanceof ScanPendingError)) throw error;
      let failure = error;
      if (error.pending.reason === "storage-unavailable") {
        const codexPending = await codexPresence.reportWhileOffline();
        const claudePending = claudePresence ? await claudePresence.reportWhileOffline() : undefined;
        const pending = codexPending ?? claudePending;
        if (error.pending.scope && pending) failure = new ScanPendingError("storage-unavailable", pending, undefined, error.retryAfterMs);
      }
      if (this.progress) failure.pending.retryAt = ScanPendingError.retryAt(this.progress.now(), failure.retryAfterMs);
      throw failure;
    }
    if (rejections.length) throw new ScanRejectedError(sessions, rejections);
    return sessions;
  }

  private async scanProvider<Entry extends SourceLine>(
    presence: SourcePresenceScan<Entry>, transcripts: AsyncIterable<TranscriptSource<Entry>>,
    selectParser: SelectParser<Entry>, rejections: RejectedBatch[],
  ): Promise<SelectedSessions> {
    const sessions: SelectedSessions = new Map();
    const rejectedStreams = new Set<string>();
    for await (const group of files(presence.scope.harness, transcripts)) {
      const file = group[0];
      const end = await file.completeEnd();
      const sources = group.map(transcript => ({ transcript, sighting: presence.capture(transcript, end) }))
        .filter(({ sighting }) => !rejectedStreams.has(sourceId(sighting.source)));
      if (!sources.length) continue;
      const snapshots = await Promise.all(sources.map(({ sighting }) => readStorage(sighting.source, () => sighting.readCheckpoint())));
      const prefixes = snapshots.flatMap(({ checkpoint }) => checkpointPrefixes(checkpoint));
      const offsets = new Set(prefixes.map(prefix => prefix.offset).filter(offset => offset <= file.fileSize));
      const verified = offsets.size ? await file.prefixDigests([...offsets]) : [];
      const digests = new Map(verified.map(({ offset, prefixDigest }) => [offset, prefixDigest]));
      let stopped = false;
      for (const [i, { sighting, transcript }] of sources.entries()) {
        const { source } = sighting;
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
    }
    return sessions;
  }

  private async views<Entry>(presence: SourcePresenceScan<Entry>, sessions: SelectedSessions, restore?: RestoreCopy<Entry>): Promise<SessionView[]> {
    for (const source of await presence.finish(restore)) sessions.set(source.sessionId, { source, required: true });
    const views: SessionView[] = [];
    for (const { source, required } of sessions.values()) {
      const view = await readStorage(source, () => this.storage.readSession({ harness: source.harness, sessionId: source.sessionId }));
      if (view) views.push(view);
      else if (required) throw new Error(`Storage has no session for ${source.harness}/${source.sessionId} after scan`);
    }
    return views;
  }

  private async importClaudeCopy(known: AcknowledgedSource, copy: TranscriptSource<ClaudeTranscriptEntry>,
    rejections: RejectedBatch[]): Promise<RestoredSource | undefined> {
    const recovery = new ClaudeSourceCopy(copy);
    const sighting = new SourceSighting(known.source, { location: known.location, observedEnd: await copy.completeEnd() }, this.storage);
    const checkpoint = () => readStorage(known.source, () => sighting.readCheckpoint());
    const start = await checkpoint();
    const digests = await recovery.verify(start.checkpoint);
    if (!digests) return;
    const result = await this.importTranscript(sighting, recovery.current(known.location),
      () => ClaudeSessionParser.forSource(false, copy.claudeSubagent), start, digests);
    if (result.rejection) {
      rejections.push(result.rejection);
      this.onRejection?.(result.rejection);
      return;
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
    if (!position.reset && start.checkpoint) sighting.verifiedVersion = start.version;
    for (;;) {
      const accepted = position.reset ? null : position.checkpoint;
      if (accepted && this.progress) await this.progress.verified(source, position, transcript);
      const format = await selectParser(transcript, accepted);
      const corrected = accepted && await TranscriptCursor.reconcileUsage(transcript, accepted, format);
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
    const known = reset || transcript.previousCopy ? await readStorage(source, () => this.storage.readSession(source)) : null;
    const cursor = await TranscriptCursor.restore(transcript, checkpoint, format, reset ? known?.messages ?? [] : undefined);
    for await (const { chat, checkpoint: next, startOffset, upgrade } of cursor.read(transcript)) {
      const expectedOffset = previous?.offset ?? 0;
      if (transcript.previousCopy && !preparePreviousCopy(chat, known, expectedOffset)) continue;
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
