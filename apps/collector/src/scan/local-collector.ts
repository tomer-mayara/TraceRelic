import { basename, relative } from "node:path";
import type { GlobalConfig } from "../config/global-config.ts";
import {
  LocalLLMHistoryClaude, LocalLLMHistoryCodex, type ScanSelection, type TranscriptSource,
} from "../history/index.ts";
import type { Batch, CheckpointSnapshot, CollectorStorage, Harness, SessionView, StreamKey } from "../storage/collector-storage.ts";
import { ClaudeSessionParser } from "./claude-session-parser.ts";
import { CodexSessionParser } from "./codex-session-parser.ts";
import type { DecodedChat } from "./decoded-chat.ts";
import { TranscriptCursor, type ParserFormat } from "./transcript-cursor.ts";

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

export class LocalCollector {
  constructor(private readonly config: GlobalConfig, private readonly storage: CollectorStorage) {}

  async scanOnce(selection: ScanSelection = {}): Promise<SessionView[]> {
    const codex = new LocalLLMHistoryCodex(this.config);
    const codexViews = await this.scanProvider("codex", codex.discoverSources(selection), () => CodexSessionParser);
    const claude = new LocalLLMHistoryClaude(this.config);
    const claudeViews = await this.scanProvider("claude", claude.discoverSources(selection), ClaudeSessionParser.forSource);
    return [...codexViews, ...claudeViews];
  }

  private async scanProvider<Entry>(
    harness: Harness, transcripts: AsyncIterable<TranscriptSource<Entry>>,
    format: (previousCopy: boolean) => ParserFormat<Entry>,
  ): Promise<SessionView[]> {
    const sessions = new Set<string>();
    for await (const transcript of transcripts) {
      const source = this.streamKey(harness, transcript);
      if (await this.importTranscript(source, transcript, format(transcript.previousCopy))) {
        sessions.add(source.sessionId);
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

  private async importTranscript<Entry>(
    source: StreamKey, transcript: TranscriptSource<Entry>, format: ParserFormat<Entry>,
  ): Promise<boolean> {
    let start = await this.storage.readCheckpoint(source);
    let retriedFrom: CheckpointSnapshot | undefined;
    for (;;) {
      const result = await this.importFrom(source, transcript, format, start);
      if (typeof result === "boolean") return result;
      // A competing correction can advance the session, this source, or both.
      start = await this.storage.readCheckpoint(source);
      const samePosition = retriedFrom && retriedFrom.checkpoint?.offset === start.checkpoint?.offset
        && retriedFrom.checkpoint?.parserState === start.checkpoint?.parserState;
      if (start.version <= result.expectedVersion || samePosition) {
        throw rejected("conflict", transcript.sourceFile, result);
      }
      if (start.checkpoint && start.checkpoint.offset > transcript.fileSize) return true;
      retriedFrom = start;
    }
  }

  private async importFrom<Entry>(
    source: StreamKey, transcript: TranscriptSource<Entry>, format: ParserFormat<Entry>, { checkpoint, version }: CheckpointSnapshot,
  ): Promise<boolean | Batch> {
    let expectedOffset = checkpoint?.offset ?? 0;
    let expectedVersion = version;
    if (expectedOffset > transcript.fileSize) {
      throw new Error(`Transcript ends before byte ${expectedOffset}: ${transcript.sourceFile}`);
    }
    const cursor = await TranscriptCursor.restore(transcript, checkpoint, format);
    const known = transcript.previousCopy ? await this.storage.readSession(source) : null;
    for await (const { chat, checkpoint: next, upgrade } of cursor.read(transcript)) {
      if (transcript.previousCopy && !preparePreviousCopy(chat, known, expectedOffset)) continue;
      const { claudeUsageReports, usageDiagnostics, ...records } = chat;
      const batch: Batch = {
        ...records, usage: chat.usage ?? [],
        source, expectedVersion, expectedOffset, checkpoint: next,
        ...(upgrade && { upgradeFromParserState: checkpoint?.parserState }),
        ...(claudeUsageReports?.length && { claudeUsageReports }),
        ...(usageDiagnostics?.length && { usageDiagnostics }),
      };
      const result = await this.storage.commit(batch);
      if (result === "conflict" && claudeUsageReports?.length) return batch;
      if (result !== "committed") throw rejected(result, transcript.sourceFile, batch);
      expectedOffset = next.offset;
      expectedVersion++;
    }
    return expectedOffset > 0;
  }
}
