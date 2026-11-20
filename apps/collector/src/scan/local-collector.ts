import { basename } from "node:path";
import type { GlobalConfig } from "../config/global-config.ts";
import {
  LocalLLMHistoryClaude, LocalLLMHistoryCodex, type ClaudeTranscript, type CodexRollout, type ScanSelection,
} from "../history/index.ts";
import type { CollectorStorage, Harness, SessionView, StreamKey } from "../storage/collector-storage.ts";
import { ClaudeChat } from "./claude-chat.ts";
import { CodexChat } from "./codex-chat.ts";
import type { DecodedChat } from "./decoded-chat.ts";

export class LocalCollector {
  constructor(private readonly config: GlobalConfig, private readonly storage: CollectorStorage) {}

  async scanOnce(selection: ScanSelection = {}): Promise<SessionView[]> {
    const codex = new LocalLLMHistoryCodex(this.config);
    const codexViews = await this.scanProvider("codex", codex.readRollouts(selection),
      rollout => JSON.stringify([this.config.codexPath, basename(rollout.sourceFile)]),
      rollout => CodexChat.decode(rollout.entries));
    const claude = new LocalLLMHistoryClaude(this.config);
    const claudeViews = await this.scanProvider("claude", claude.readTranscripts(selection),
      transcript => transcript.sourceFile, ClaudeChat.decode);
    return [...codexViews, ...claudeViews];
  }

  private async scanProvider<T extends CodexRollout | ClaudeTranscript>(
    harness: Harness, transcripts: AsyncIterable<T>, streamId: (file: T) => string, decode: (file: T) => DecodedChat,
  ): Promise<SessionView[]> {
    const sessions = new Set<string>();
    for await (const transcript of transcripts) {
      const source = { harness, sessionId: transcript.sessionId, streamId: streamId(transcript) };
      if (await this.importTranscript(source, transcript, () => decode(transcript))) sessions.add(source.sessionId);
    }
    const views: SessionView[] = [];
    for (const sessionId of sessions) {
      const view = await this.storage.readSession({ harness, sessionId });
      if (!view) throw new Error(`Storage has no session for ${harness}/${sessionId} after scan`);
      views.push(view);
    }
    return views;
  }

  private async importTranscript(
    source: StreamKey, transcript: CodexRollout | ClaudeTranscript, decode: () => DecodedChat,
  ): Promise<boolean> {
    const previous = await this.storage.readCheckpoint(source);
    const start = previous?.offset ?? 0;
    const { endOffset, sourceFile } = transcript;
    if (endOffset === start) return true;
    if (endOffset < start) throw new Error(`Transcript ends before byte ${start}: ${sourceFile}`);
    const chat = decode();
    const firstUnread = transcript.entries.find(entry => entry.endOffset > start);
    if (!firstUnread) throw new Error(`Missing complete record after byte ${start}: ${sourceFile}`);
    // A mirror appended later can describe blocks at an already accepted source position.
    const messages = chat.messages.filter(message => message.sourceOrder >= firstUnread.lineNumber);
    const metadata = { ...chat.metadata };
    if ("previousCopy" in transcript && transcript.previousCopy) {
      const known = await this.storage.readSession(source);
      if (!known && messages.length === 0 && Object.keys(metadata).length === 0) return false;
      // An earlier copy can fill a missing field. Storage orders branch hints by their recorded positions.
      for (const field of ["cwd", "repository", "parentSessionId"] as const) {
        if (known?.metadata[field] !== undefined) delete metadata[field];
      }
    }
    const result = await this.storage.commit({
      source, expectedOffset: start, checkpoint: { offset: endOffset, parserState: "{}" },
      metadata, branchObservation: chat.branchObservation, messages, usage: [],
    });
    if (result !== "committed") {
      throw new Error(`Storage returned ${result} for ${sourceFile}, bytes ${start}..${endOffset}`);
    }
    return true;
  }
}
