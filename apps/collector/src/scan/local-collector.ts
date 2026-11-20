import { basename, relative } from "node:path";
import type { GlobalConfig } from "../config/global-config.ts";
import {
  LocalLLMHistoryClaude, LocalLLMHistoryCodex, type ScanSelection, type TranscriptSource, type VerifiedPrefix,
} from "../history/index.ts";
import type { Batch, Checkpoint, CheckpointSnapshot, CollectorStorage, Harness, SessionView, StreamKey } from "../storage/collector-storage.ts";
import { ClaudeSessionParser } from "./claude-session-parser.ts";
import { CodexSessionParser } from "./codex-session-parser.ts";
import type { DecodedChat } from "./decoded-chat.ts";
import { TranscriptCursor, type ParserFormat, type SourceLine } from "./transcript-cursor.ts";

function preparePreviousCopy(chat: DecodedChat, known: SessionView | null, offset: number): boolean {
  if (!offset && !known && !chat.messages.length && !Object.keys(chat.metadata).length
    && !chat.claudeUsageReports?.length && !chat.usageDiagnostics?.length) return false;
  // Earlier copies can fill missing fields. Storage compares branches by their recorded positions.
  for (const field of ["cwd", "repository", "parentSessionId"] as const) {
    if (known?.metadata[field] !== undefined) delete chat.metadata[field];
  }
  return true;
}

function rejected(result: "conflict" | "invalid", file: string, batch: Batch): Error {
  return new Error(`Storage returned ${result} for ${file}, bytes ${batch.expectedOffset}..${batch.checkpoint.offset}`);
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

function sameCheckpoint(left: Checkpoint | null, right: Checkpoint | null): boolean {
  return left?.offset === right?.offset && left?.prefixDigest === right?.prefixDigest && left?.parserState === right?.parserState
    && left?.replayThrough?.offset === right?.replayThrough?.offset && left?.replayThrough?.prefixDigest === right?.replayThrough?.prefixDigest;
}

function checkpointPrefixes(checkpoint: Checkpoint | null): VerifiedPrefix[] {
  if (!checkpoint?.prefixDigest) return [];
  const accepted = { offset: checkpoint.offset, prefixDigest: checkpoint.prefixDigest };
  return checkpoint.replayThrough ? [accepted, checkpoint.replayThrough] : [accepted];
}

function verifiedCheckpoint(checkpoint: Checkpoint, digests: ReadonlyMap<number, string>): boolean {
  return !!checkpoint.prefixDigest && checkpointPrefixes(checkpoint).every(prefix => digests.get(prefix.offset) === prefix.prefixDigest);
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
    const sessions = new Set<string>();
    for await (const group of files(harness, transcripts)) {
      const sources = group.map(transcript => this.streamKey(harness, transcript));
      const snapshots = await Promise.all(sources.map(key => this.storage.readCheckpoint(key)));
      const file = group[0];
      const prefixes = snapshots.flatMap(({ checkpoint }) => checkpointPrefixes(checkpoint));
      const offsets = new Set(prefixes.map(prefix => prefix.offset).filter(offset => offset <= file.fileSize));
      const verified = offsets.size ? await file.prefixDigests([...offsets]) : [];
      const digests = new Map(verified.map(({ offset, prefixDigest }) => [offset, prefixDigest]));
      for (const [i, transcript] of group.entries()) {
        if (await this.importTranscript(sources[i], transcript, format(transcript.previousCopy), snapshots[i], digests)) {
          sessions.add(sources[i].sessionId);
        }
      }
    }
    const views: SessionView[] = [];
    for (const sessionId of sessions) {
      const view = await this.storage.readSession({ harness, sessionId });
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
    start: CheckpointSnapshot, digests: Map<number, string>,
  ): Promise<boolean> {
    let retriedFrom: CheckpointSnapshot | undefined;
    for (;;) {
      const reset = !!start.checkpoint && !verifiedCheckpoint(start.checkpoint, digests);
      const result = await this.importFrom(source, transcript, format, start, reset);
      if (typeof result === "boolean") return result;
      // A competing correction can advance the session, this source, or both.
      const previous = start.checkpoint;
      start = await this.storage.readCheckpoint(source);
      if (start.version <= result.expectedVersion || (retriedFrom && sameCheckpoint(retriedFrom.checkpoint, start.checkpoint))) {
        throw rejected("conflict", transcript.sourceFile, result);
      }
      if (start.checkpoint && start.checkpoint.offset > transcript.fileSize) return true;
      if (start.checkpoint && !sameCheckpoint(previous, start.checkpoint)) {
        // A stale capture cannot reset a replacement that another writer already accepted.
        const offsets = checkpointPrefixes(start.checkpoint).map(prefix => prefix.offset).filter(offset => offset <= transcript.fileSize);
        for (const { offset, prefixDigest } of await transcript.prefixDigests(offsets)) digests.set(offset, prefixDigest);
        if (!verifiedCheckpoint(start.checkpoint, digests)) throw rejected("conflict", transcript.sourceFile, result);
      }
      retriedFrom = start;
    }
  }

  private async importFrom<Entry extends SourceLine>(
    source: StreamKey, transcript: TranscriptSource<Entry>, format: ParserFormat<Entry>,
    { checkpoint, version }: CheckpointSnapshot, reset: boolean,
  ): Promise<boolean | Batch> {
    let expectedOffset = checkpoint?.offset ?? 0;
    let expectedVersion = version;
    let resetFrom = reset ? checkpoint : null;
    const known = reset || transcript.previousCopy ? await this.storage.readSession(source) : null;
    const cursor = await TranscriptCursor.restore(transcript, checkpoint, format, reset ? known?.messages ?? [] : undefined);
    for await (const { chat, checkpoint: next, upgrade } of cursor.read(transcript)) {
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
      const result = await this.storage.commit(batch);
      if (result === "conflict" && claudeUsageReports?.length) return batch;
      if (result !== "committed") throw rejected(result, transcript.sourceFile, batch);
      resetFrom = null;
      expectedOffset = next.offset;
      expectedVersion++;
    }
    return expectedOffset > 0;
  }
}
