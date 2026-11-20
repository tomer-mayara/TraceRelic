import type { ClaudeSubagent, ClaudeTranscriptEntry } from "../history/index.ts";
import { ClaudeChat } from "./claude-chat.ts";
import { ClaudeUsage } from "./claude-usage.ts";
import type { ChatParser, DecodedChat } from "./decoded-chat.ts";
import type { ParserFormat } from "./transcript-cursor.ts";

export class ClaudeSessionParser implements ChatParser<ClaudeTranscriptEntry> {
  private constructor(private readonly chat: ClaudeChat, private readonly previousCopy: boolean, private readonly subagent?: ClaudeSubagent) {}

  static forSource(previousCopy: boolean, subagent?: ClaudeSubagent): ParserFormat<ClaudeTranscriptEntry> {
    const resume = (state?: unknown) => new ClaudeSessionParser(ClaudeChat.resume(previousCopy, state), previousCopy, subagent);
    return {
      version: 2, claudeCallOrigins: true,
      resume,
      upgrade(oldChat) {
        const parser = resume(oldChat);
        return {
          parser,
          read(entries) {
            if (!oldChat) parser.chat.decodeBatch(entries);
            return ClaudeUsage.decodeBatch(entries, subagent, previousCopy);
          },
        };
      },
    };
  }

  decodeBatch(entries: readonly ClaudeTranscriptEntry[]): DecodedChat {
    const chat = this.chat.decodeBatch(entries);
    const { metadata, ...usage } = ClaudeUsage.decodeBatch(entries, this.subagent, this.previousCopy);
    Object.assign(chat.metadata, metadata);
    return { ...chat, ...usage };
  }

  snapshot(): object {
    // The session transaction holds usage evidence shared by all copies.
    return this.chat.snapshot();
  }
}
