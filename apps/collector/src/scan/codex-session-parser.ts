import type { CodexRolloutEntry, RecordBatch } from "../history/index.ts";
import { invalidState, stateRecord } from "./chat-parser-state.ts";
import { CodexChat } from "./codex-chat.ts";
import { CodexUsage } from "./codex-usage.ts";
import type { ChatParser, DecodedChat } from "./decoded-chat.ts";

export class CodexSessionParser implements ChatParser<CodexRolloutEntry> {
  static readonly version = 2;

  private constructor(private readonly chat: CodexChat, private readonly counts: CodexUsage) {}

  static resume(state?: unknown): CodexSessionParser {
    if (state === undefined) return new CodexSessionParser(CodexChat.resume(), CodexUsage.resume());
    const saved = stateRecord(state, ["chat", "usage"]);
    if (saved.chat === undefined || saved.usage === undefined) invalidState();
    return new CodexSessionParser(CodexChat.resume(saved.chat), CodexUsage.resume(saved.usage));
  }

  static upgrade(oldChat?: object) {
    const parser = new CodexSessionParser(CodexChat.resume(oldChat), CodexUsage.resume());
    return {
      parser,
      read(entries: readonly CodexRolloutEntry[]) {
        // Version 1 already saved the chat state. Only the earlier empty checkpoint needs to reconstruct it.
        if (!oldChat) parser.chat.decodeBatch(entries);
        return parser.counts.decodeBatch(entries);
      },
    };
  }

  prepareLookahead(first: readonly CodexRolloutEntry[], tail: AsyncIterable<RecordBatch<CodexRolloutEntry>>, line: number): Promise<void> {
    return this.chat.prepareLookahead(first, tail, line);
  }

  decodeBatch(entries: readonly CodexRolloutEntry[]): DecodedChat {
    return { ...this.chat.decodeBatch(entries), ...this.counts.decodeBatch(entries) };
  }

  snapshot(): object {
    return { chat: this.chat.snapshot(), usage: this.counts.snapshot() };
  }
}
