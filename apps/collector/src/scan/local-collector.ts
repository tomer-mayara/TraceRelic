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
import { TranscriptCursor, type ParserFormat, type SourceLine } from "./transcript-cursor.ts";

export { ScanPendingError, type PendingScan } from "./scan-pending.ts";

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
  constructor(private readonly config: GlobalConfig, private readonly storage: CollectorStorage) {}

  async scanOnce(selection: ScanSelection = {}): Promise<SessionView[]> {
    const codex = new LocalLLMHistoryCodex(this.config);
    const codexViews = await this.scanProvider("codex", codex.discoverSources(selection), () => CodexSessionParser);
    const claude = new LocalLLMHistoryClaude(this.config);
    const claudeViews = await this.scanProvider("claude", claude.discoverSources(selection), ClaudeSessionParser.forSource);
    return [...codexViews, ...claudeViews];
  }

  private async scanProvider<Entry extends SourceLine>(
    harness: Harness, transcripts: AsyncIterable<TranscriptSource<Entry>>,
    format: (previousCopy: boolean) => ParserFormat<Entry>,
  ): Promise<SessionView[]> {
    const sessions = new Map<string, StreamKey>();
    for await (const group of files(harness, transcripts)) {
      const sources = group.map(transcript => this.streamKey(harness, transcript));
      const snapshots = await Promise.all(sources.map(key => readStorage(key, () => this.storage.readCheckpoint(key))));
      const file = group[0];
      const prefixes = snapshots.flatMap(({ checkpoint }) => checkpointPrefixes(checkpoint));
      const offsets = new Set(prefixes.map(prefix => prefix.offset).filter(offset => offset <= file.fileSize));
      const verified = offsets.size ? await file.prefixDigests([...offsets]) : [];
      const digests = new Map(verified.map(({ offset, prefixDigest }) => [offset, prefixDigest]));
      for (const [i, transcript] of group.entries()) {
        if (await this.importTranscript(sources[i], transcript, format(transcript.previousCopy), snapshots[i], digests)) {
          sessions.set(sources[i].sessionId, sources[i]);
        }
      }
    }
    const views: SessionView[] = [];
    for (const [sessionId, source] of sessions) {
      const view = await readStorage(source, () => this.storage.readSession({ harness, sessionId }));
      if (!view) throw new Error(`Storage has no session for ${harness}/${sessionId} after scan`);
      views.push(view);
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
  ): Promise<boolean> {
    const recovery = new ScanRecovery(this.storage, transcript);
    let position: ScanRestart = start.checkpoint && !verifiedCheckpoint(start.checkpoint, digests) ? { ...start, reset: true } : start;
    for (;;) {
      const result = await this.importFrom(source, transcript, format, position, recovery);
      if (typeof result === "boolean") return result;
      position = result;
    }
  }

  private async importFrom<Entry extends SourceLine>(
    source: StreamKey, transcript: TranscriptSource<Entry>, format: ParserFormat<Entry>,
    { checkpoint, version, reset }: ScanRestart, recovery: ScanRecovery,
  ): Promise<boolean | ScanRestart> {
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
      const winner = await recovery.commit(batch, previous, Math.min(startOffset, expectedOffset));
      if (winner) return winner;
      resetFrom = null;
      previous = next;
      expectedVersion++;
    }
    return (previous?.offset ?? 0) > 0;
  }
}
