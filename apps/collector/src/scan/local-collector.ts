import { basename, relative } from "node:path";
import type { GlobalConfig } from "../config/global-config.ts";
import {
  LocalLLMHistoryClaude, LocalLLMHistoryCodex, type ScanSelection, type TranscriptSource,
} from "../history/index.ts";
import type { CollectorStorage, Harness, SessionView, StreamKey } from "../storage/collector-storage.ts";
import { ClaudeChat } from "./claude-chat.ts";
import { CodexChat } from "./codex-chat.ts";
import type { ChatParser } from "./decoded-chat.ts";
import { TranscriptCursor } from "./transcript-cursor.ts";

export class LocalCollector {
  constructor(private readonly config: GlobalConfig, private readonly storage: CollectorStorage) {}

  async scanOnce(selection: ScanSelection = {}): Promise<SessionView[]> {
    const codex = new LocalLLMHistoryCodex(this.config);
    const codexViews = await this.scanProvider("codex", codex.discoverSources(selection),
      (_previousCopy, state) => CodexChat.resume(state));
    const claude = new LocalLLMHistoryClaude(this.config);
    const claudeViews = await this.scanProvider("claude", claude.discoverSources(selection),
      (previousCopy, state) => ClaudeChat.resume(previousCopy, state));
    return [...codexViews, ...claudeViews];
  }

  private async scanProvider<Entry>(
    harness: Harness, transcripts: AsyncIterable<TranscriptSource<Entry>>,
    resume: (previousCopy: boolean, state?: unknown) => ChatParser<Entry>,
  ): Promise<SessionView[]> {
    const sessions = new Set<string>();
    for await (const transcript of transcripts) {
      const source = this.streamKey(harness, transcript);
      if (await this.importTranscript(source, transcript, state => resume(transcript.previousCopy, state))) {
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
    source: StreamKey, transcript: TranscriptSource<Entry>, resume: (state?: unknown) => ChatParser<Entry>,
  ): Promise<boolean> {
    const { checkpoint, version } = await this.storage.readCheckpoint(source);
    let expectedOffset = checkpoint?.offset ?? 0;
    let expectedVersion = version;
    if (checkpoint && expectedOffset === transcript.fileSize) return true;
    if (expectedOffset > transcript.fileSize) {
      throw new Error(`Transcript ends before byte ${expectedOffset}: ${transcript.sourceFile}`);
    }
    const cursor = await TranscriptCursor.restore(transcript, checkpoint, resume);
    const known = transcript.previousCopy ? await this.storage.readSession(source) : null;
    let prepare = cursor.parser.prepareLookahead?.bind(cursor.parser);
    for await (const { entries, next } of transcript.readBatches(cursor.position)) {
      if (prepare && next.offset < transcript.fileSize) {
        await prepare(entries, transcript.readBatches(next), cursor.position.lineNumber);
        prepare = undefined;
      }
      const { messages, metadata, branchObservation } = cursor.parser.decodeBatch(entries);
      if (transcript.previousCopy) {
        if (!expectedOffset && !known && !messages.length && !Object.keys(metadata).length) continue;
        // Earlier copies can fill missing fields. Storage compares branch observations by their recorded positions.
        for (const field of ["cwd", "repository", "parentSessionId"] as const) {
          if (known?.metadata[field] !== undefined) delete metadata[field];
        }
      }
      const result = await this.storage.commit({
        source, expectedVersion, expectedOffset, checkpoint: cursor.checkpointAt(next),
        metadata, branchObservation, messages, usage: [],
      });
      if (result !== "committed") {
        throw new Error(`Storage returned ${result} for ${transcript.sourceFile}, bytes ${expectedOffset}..${next.offset}`);
      }
      expectedOffset = next.offset;
      expectedVersion++;
    }
    return expectedOffset > 0;
  }
}
