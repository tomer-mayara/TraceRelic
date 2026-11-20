import { basename, relative } from "node:path";
import type { GlobalConfig } from "../config/global-config.ts";
import {
  LocalLLMHistoryClaude, LocalLLMHistoryCodex, type ScanSelection, type TranscriptSource,
} from "../history/index.ts";
import type { Batch, CheckpointSnapshot, CollectorStorage, Harness, SessionView, StreamKey } from "../storage/collector-storage.ts";
import { ClaudeSessionParser } from "./claude-session-parser.ts";
import { CodexSessionParser } from "./codex-session-parser.ts";
import type { DecodedChat } from "./decoded-chat.ts";
import { ScanRecovery, checkpointPrefixes, readStorage, verifiedCheckpoint, type ScanRestart } from "./scan-recovery.ts";
import { ScanRejectedError, type RejectedBatch } from "./scan-rejected.ts";
import { TranscriptCursor, type ParserFormat, type SourceLine } from "./transcript-cursor.ts";

export { ScanPendingError, type PendingScan } from "./scan-pending.ts";
export { ScanRejectedError, type RejectedBatch } from "./scan-rejected.ts";

interface TranscriptResult {
  hasStoredSession: boolean;
  rejection?: RejectedBatch;
}

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
  constructor(
    private readonly config: GlobalConfig, private readonly storage: CollectorStorage,
    private readonly onRejection?: (report: RejectedBatch) => void,
  ) {}

  async scanOnce(selection: ScanSelection = {}): Promise<SessionView[]> {
    const codex = new LocalLLMHistoryCodex(this.config);
    const rejections: RejectedBatch[] = [];
    const codexViews = await this.scanProvider("codex", codex.discoverSources(selection), () => CodexSessionParser, rejections);
    const claude = new LocalLLMHistoryClaude(this.config);
    const claudeViews = await this.scanProvider("claude", claude.discoverSources(selection), ClaudeSessionParser.forSource, rejections);
    const sessions = [...codexViews, ...claudeViews];
    if (rejections.length) throw new ScanRejectedError(sessions, rejections);
    return sessions;
  }

  private async scanProvider<Entry extends SourceLine>(
    harness: Harness, transcripts: AsyncIterable<TranscriptSource<Entry>>,
    format: (previousCopy: boolean) => ParserFormat<Entry>, rejections: RejectedBatch[],
  ): Promise<SessionView[]> {
    const sessions = new Map<string, { source: StreamKey; required: boolean }>();
    const rejectedStreams = new Set<string>();
    for await (const group of files(harness, transcripts)) {
      const sources = group.map(transcript => ({ transcript, source: this.streamKey(harness, transcript) }))
        .filter(({ source }) => !rejectedStreams.size || !rejectedStreams.has(JSON.stringify(source)));
      if (!sources.length) continue;
      const snapshots = await Promise.all(sources.map(({ source }) => readStorage(source, () => this.storage.readCheckpoint(source))));
      const file = group[0];
      const prefixes = snapshots.flatMap(({ checkpoint }) => checkpointPrefixes(checkpoint));
      const offsets = new Set(prefixes.map(prefix => prefix.offset).filter(offset => offset <= file.fileSize));
      const verified = offsets.size ? await file.prefixDigests([...offsets]) : [];
      const digests = new Map(verified.map(({ offset, prefixDigest }) => [offset, prefixDigest]));
      let stopped = false;
      for (const [i, { source, transcript }] of sources.entries()) {
        // After a rejection, other sessions in this file can still have data from earlier scans.
        const result: TranscriptResult = stopped ? { hasStoredSession: snapshots[i].version > 0 }
          : await this.importTranscript(source, transcript, format(transcript.previousCopy), snapshots[i], digests);
        if (result.rejection) {
          stopped = true;
          rejectedStreams.add(JSON.stringify(source));
          rejections.push(result.rejection);
          this.onRejection?.(result.rejection);
        }
        if (result.hasStoredSession || (stopped && !sessions.has(source.sessionId))) {
          sessions.set(source.sessionId, { source, required: result.hasStoredSession });
        }
      }
    }
    const views: SessionView[] = [];
    for (const [sessionId, { source, required }] of sessions) {
      const view = await readStorage(source, () => this.storage.readSession({ harness, sessionId }));
      if (view) views.push(view);
      else if (required) throw new Error(`Storage has no session for ${harness}/${sessionId} after scan`);
    }
    return views;
  }

  private streamKey(harness: Harness, { sessionId, sourceFile }: TranscriptSource<unknown>): StreamKey {
    const { codexPath, claudePath, installationId } = this.config;
    let streamId = sourceFile;
    if (harness === "codex") {
      const name = basename(sourceFile);
      streamId = installationId ? name : JSON.stringify([codexPath, name]);
    } else if (installationId && claudePath) {
      streamId = relative(claudePath, sourceFile);
    }
    return { harness, sessionId, streamId, ...(installationId && { installationId }) };
  }

  private async importTranscript<Entry extends SourceLine>(
    source: StreamKey, transcript: TranscriptSource<Entry>, format: ParserFormat<Entry>,
    start: CheckpointSnapshot, digests: ReadonlyMap<number, string>,
  ): Promise<TranscriptResult> {
    const recovery = new ScanRecovery(this.storage, transcript);
    let position: ScanRestart = start.checkpoint && !verifiedCheckpoint(start.checkpoint, digests) ? { ...start, reset: true } : start;
    for (;;) {
      const result = await this.importFrom(source, transcript, format, position, recovery);
      if ("hasStoredSession" in result) return result;
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
