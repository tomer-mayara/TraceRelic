import type { DecodedChat } from "@tracerelic/collector/scan";
import { ClaudeChat } from "#src/providers/claude/claude-chat";
import type { ClaudeTranscript } from "./transcript-snapshots.ts";

type Row = Record<string, unknown>;

export class ClaudeChatFixture {
  static readonly at = "2026-02-03T17:01:00.123-06:00";

  static row(role: string, content: unknown, fields: Row = {}): Row {
    return { type: role, timestamp: this.at, message: { id: "shared", role, content }, ...fields };
  }

  static text(text: string) {
    return { type: "text", text };
  }

  static transcript(rows: Row[], sourceFile = "/fixture/current.jsonl", previousCopy = false): ClaudeTranscript {
    const sessionId = "session";
    const entries = rows.map((record, index) => ({
      harness: "claude" as const, sessionId, sourceFile, lineNumber: index + 1, endOffset: (index + 1) * 100,
      ...(typeof record.timestamp === "string" && { timestamp: record.timestamp }), record,
    }));
    return { sessionId, sourceFile, entries, endOffset: rows.length * 100, previousCopy };
  }

  static decode(transcript: ClaudeTranscript): DecodedChat {
    return ClaudeChat.resume(transcript.previousCopy).decodeBatch(transcript.entries);
  }
}
