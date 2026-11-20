import type { ClaudeTranscriptEntry } from "../history/index.ts";
import { ClaudeChat } from "./claude-chat.ts";
import { ClaudeUsage } from "./claude-usage.ts";
import type { ChatParser, DecodedChat } from "./decoded-chat.ts";
import type { ParserFormat } from "./transcript-cursor.ts";

export class ClaudeSessionParser implements ChatParser<ClaudeTranscriptEntry> {
  private constructor(private readonly chat: ClaudeChat) {}

  static forSource(previousCopy: boolean): ParserFormat<ClaudeTranscriptEntry> {
    const resume = (state?: unknown) => new ClaudeSessionParser(ClaudeChat.resume(previousCopy, state));
    return {
      version: 2,
      resume,
      upgrade(oldChat) {
        const parser = resume(oldChat);
        return {
          parser,
          read(entries) {
            if (!oldChat) parser.chat.decodeBatch(entries);
            return ClaudeUsage.decodeBatch(entries);
          },
        };
      },
    };
  }

  decodeBatch(entries: readonly ClaudeTranscriptEntry[]): DecodedChat {
    return { ...this.chat.decodeBatch(entries), ...ClaudeUsage.decodeBatch(entries) };
  }

  snapshot(): object {
    // The session transaction holds usage evidence shared by all copies.
    return this.chat.snapshot();
  }
}
