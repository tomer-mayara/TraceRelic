import type { ClaudeTranscript, ClaudeTranscriptEntry } from "../index.ts";
import { JsonRecord } from "../../transcript/json-record.ts";
import type { Metadata } from "../../storage/collector-storage.ts";
import { ParserState, TextOccurrences } from "../../scan/parser-state.ts";
import type { ChatParser, DecodedChat } from "../../scan/decoded-chat.ts";
import { ClaudeVisibleText } from "./claude-visible-text.ts";

export class ClaudeChat implements ChatParser<ClaudeTranscriptEntry> {
  private readonly previousCopy: boolean;
  private readonly occurrences: TextOccurrences;

  private constructor(previousCopy: boolean, occurrences: TextOccurrences) {
    this.previousCopy = previousCopy;
    this.occurrences = occurrences;
  }

  static resume(previousCopy: boolean, state?: unknown): ClaudeChat {
    if (state === undefined) return new ClaudeChat(previousCopy, new TextOccurrences());
    const saved = ParserState.record(state, ["occurrences"]);
    return new ClaudeChat(previousCopy, TextOccurrences.restore(saved.occurrences));
  }

  static decode(transcript: ClaudeTranscript): DecodedChat {
    return ClaudeChat.resume(transcript.previousCopy).decodeBatch(transcript.entries);
  }

  decodeBatch(entries: readonly ClaudeTranscriptEntry[]): DecodedChat {
    const result: DecodedChat = { messages: [], metadata: {} };
    for (const entry of entries) this.read(entry, result);
    return result;
  }

  snapshot(): object {
    return { occurrences: this.occurrences.snapshot() };
  }

  private read({ record, timestamp, lineNumber, sourceFile }: ClaudeTranscriptEntry, result: DecodedChat): void {
    const uuid = JsonRecord.identifier(record.uuid);
    if (this.previousCopy && !uuid) return;

    const context: Metadata = {};
    const cwd = JsonRecord.identifier(record.cwd);
    const repository = JsonRecord.identifier(record.repository);
    const branch = JsonRecord.identifier(record.gitBranch);
    if (cwd) context.cwd = result.metadata.cwd = cwd;
    if (repository) context.repository = result.metadata.repository = repository;
    if (branch) {
      context.branch = result.metadata.branch = branch;
      result.branchObservation = { sourceOrder: lineNumber, ...(timestamp && { at: timestamp }) };
    }

    const role = record.type;
    const message = JsonRecord.object(record.message);
    if (!timestamp || (role !== "user" && role !== "assistant") || !message) return;
    if (message.role !== undefined && role !== message.role) return;
    if (record.isMeta === true || record.isCompactSummary === true || message.model === "<synthetic>") return;
    const blocks = ClaudeVisibleText.blocks(message.content, role === "user");
    if (!blocks.length) return;
    const turnId = JsonRecord.identifier(record.turnId);
    const requestId = JsonRecord.identifier(record.requestId);
    const identity = uuid ? `native:${uuid}`
      : this.occurrences.identify([sourceFile, role, timestamp, turnId, requestId, blocks]);
    for (const { text, blockIndex } of blocks) {
      result.messages.push({
        id: `${identity}:${blockIndex}`, role, at: timestamp, sourceOrder: lineNumber, blockIndex, text,
        ...(turnId && { turnId }), ...(requestId && { requestId }), ...((cwd || repository || branch) && { context }),
      });
    }
  }
}
