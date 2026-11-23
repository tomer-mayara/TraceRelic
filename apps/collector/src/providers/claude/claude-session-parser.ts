import { claudeCopyFallbackFields } from "@tracerelic/shared";
import type { ClaudeTranscriptEntry } from "../index.ts";
import type { ClaudeSubagent } from "../../transcript/index.ts";
import type { SessionView } from "../../storage/collector-storage.ts";
import { ClaudeChat } from "./claude-chat.ts";
import { ClaudeUsage } from "./claude-usage.ts";
import type { ChatParser, DecodedChat } from "../../scan/decoded-chat.ts";
import type { ParserFormat } from "../../scan/transcript-cursor.ts";

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
      ...(previousCopy && { prepareBatch: ClaudeSessionParser.preparePreviousCopy }),
    };
  }

  private static preparePreviousCopy(chat: DecodedChat, known: SessionView | null, offset: number): boolean {
    if (!offset && !known && !chat.messages.length && !Object.keys(chat.metadata).length
      && !chat.claudeUsageReports?.length && !chat.usageDiagnostics?.length) return false;
    // Earlier copies can fill missing fields. Storage compares branches by their recorded positions.
    for (const field of claudeCopyFallbackFields) {
      if (known?.metadata[field] !== undefined) delete chat.metadata[field];
    }
    return true;
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
