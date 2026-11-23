import type { ClaudeTranscript, ClaudeTranscriptEntry } from "../providers/index.ts";
import type { Metadata } from "../storage/collector-storage.ts";
import { stateRecord, TextOccurrences } from "./chat-parser-state.ts";
import type { ChatParser, DecodedChat } from "./decoded-chat.ts";

type TextBlock = { text: string; blockIndex: number };

export class ClaudeChat implements ChatParser<ClaudeTranscriptEntry> {
  private readonly previousCopy: boolean;
  private readonly occurrences: TextOccurrences;

  private constructor(previousCopy: boolean, occurrences: TextOccurrences) {
    this.previousCopy = previousCopy;
    this.occurrences = occurrences;
  }

  static resume(previousCopy: boolean, state?: unknown): ClaudeChat {
    if (state === undefined) return new ClaudeChat(previousCopy, new TextOccurrences());
    const saved = stateRecord(state, ["occurrences"]);
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
    const uuid = identifier(record.uuid);
    if (this.previousCopy && !uuid) return;

    const context: Metadata = {};
    const cwd = identifier(record.cwd);
    const repository = identifier(record.repository);
    const branch = identifier(record.gitBranch);
    if (cwd) context.cwd = result.metadata.cwd = cwd;
    if (repository) context.repository = result.metadata.repository = repository;
    if (branch) {
      context.branch = result.metadata.branch = branch;
      result.branchObservation = { sourceOrder: lineNumber, ...(timestamp && { at: timestamp }) };
    }

    const role = record.type;
    const message = object(record.message);
    if (!timestamp || (role !== "user" && role !== "assistant") || !message) return;
    if (message.role !== undefined && role !== message.role) return;
    if (record.isMeta === true || record.isCompactSummary === true || message.model === "<synthetic>") return;
    const blocks = visibleBlocks(message.content, role === "user");
    if (!blocks.length) return;
    const turnId = identifier(record.turnId);
    const requestId = identifier(record.requestId);
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

function visibleBlocks(content: unknown, user: boolean): TextBlock[] {
  const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
  if (!Array.isArray(parts)) return [];
  const blocks: TextBlock[] = [];
  for (const [blockIndex, part] of parts.entries()) {
    const block = object(part);
    if (block?.type !== "text" || typeof block.text !== "string" || !block.text.length) continue;
    if (user && injectedText(block.text)) continue;
    blocks.push({ blockIndex, text: block.text });
  }
  return blocks;
}

function injectedText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "[Request interrupted by user]" || trimmed === "[Request interrupted by user for tool use]") return true;
  return /^<(tick|goal|ide_opened_file|ide_selection|session-start-hook|system-reminder|local-command-stdout|local-command-stderr|local-command-caveat)>[\s\S]*<\/\1>$/.test(trimmed)
    || /^<command-name>[^<]*<\/command-name>(?:\s*<command-message>[^<]*<\/command-message>)?(?:\s*<command-args>[\s\S]*<\/command-args>)?$/.test(trimmed);
}

function identifier(value: unknown): string | undefined {
  if (typeof value === "string" && value.length) return value;
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
}
