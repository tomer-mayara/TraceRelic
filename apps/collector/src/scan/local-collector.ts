import { basename } from "node:path";
import type { GlobalConfig } from "../config/global-config.ts";
import { LocalLLMHistoryCodex, type CodexRollout, type CodexSelection } from "../history/index.ts";
import type { CollectorStorage, SessionView, StreamKey } from "../storage/collector-storage.ts";
import { CodexChat } from "./codex-chat.ts";

export class LocalCollector {
  constructor(private readonly config: GlobalConfig, private readonly storage: CollectorStorage) {}

  async scanOnce(selection: CodexSelection = {}): Promise<SessionView[]> {
    const reader = new LocalLLMHistoryCodex(this.config);
    const sessions = new Set<string>();
    for await (const rollout of reader.readRollouts(selection)) {
      await this.importRollout(rollout);
      sessions.add(rollout.sessionId);
    }
    const views: SessionView[] = [];
    for (const sessionId of sessions) {
      const view = await this.storage.readSession({ harness: "codex", sessionId });
      if (!view) throw new Error(`Storage has no session for codex/${sessionId} after scan`);
      views.push(view);
    }
    return views;
  }

  private async importRollout(rollout: CodexRollout): Promise<void> {
    const source: StreamKey = {
      harness: "codex", sessionId: rollout.sessionId,
      streamId: JSON.stringify([this.config.codexPath, basename(rollout.sourceFile)]),
    };
    const previous = await this.storage.readCheckpoint(source);
    const start = previous?.offset ?? 0;
    if (rollout.endOffset === start) return;
    if (rollout.endOffset < start) throw new Error(`Transcript ends before byte ${start}: ${rollout.sourceFile}`);
    const chat = CodexChat.decode(rollout.entries);
    const firstUnread = rollout.entries.find(entry => entry.endOffset > start);
    if (!firstUnread) throw new Error(`Missing complete record after byte ${start}: ${rollout.sourceFile}`);
    // A mirror appended later can describe blocks at an already accepted source position.
    const messages = chat.messages.filter(message => message.sourceOrder >= firstUnread.lineNumber);
    const result = await this.storage.commit({
      source, expectedOffset: start, checkpoint: { offset: rollout.endOffset, parserState: "{}" },
      metadata: chat.metadata, branchObservation: chat.branchObservation, messages, usage: [],
    });
    if (result !== "committed") {
      throw new Error(`Storage returned ${result} for ${rollout.sourceFile}, bytes ${start}..${rollout.endOffset}`);
    }
  }
}
