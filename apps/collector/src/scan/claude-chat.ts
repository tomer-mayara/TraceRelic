import { createHash } from "node:crypto";
import type { ClaudeTranscript, ClaudeTranscriptEntry } from "../history/index.ts";
import type { Metadata } from "../storage/collector-storage.ts";
import type { DecodedChat } from "./decoded-chat.ts";

type TextBlock = { text: string; blockIndex: number };

export class ClaudeChat {
  private readonly result: DecodedChat = { messages: [], metadata: {} };
  private readonly occurrences = new Map<string, number>();

  private constructor() {}

  static decode(transcript: ClaudeTranscript): DecodedChat {
    const chat = new ClaudeChat();
    for (const entry of transcript.entries) chat.read(entry, transcript.previousCopy);
    return chat.result;
  }

  private read({ record, timestamp, lineNumber, sourceFile }: ClaudeTranscriptEntry, previousCopy: boolean): void {
    const uuid = identifier(record.uuid);
    if (previousCopy && !uuid) return;

    const context: Metadata = {};
    const cwd = identifier(record.cwd);
    const repository = identifier(record.repository);
    const branch = identifier(record.gitBranch);
    if (cwd) context.cwd = this.result.metadata.cwd = cwd;
    if (repository) context.repository = this.result.metadata.repository = repository;
    if (branch) {
      context.branch = this.result.metadata.branch = branch;
      this.result.branchObservation = { sourceOrder: lineNumber, ...(timestamp && { at: timestamp }) };
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
    const identity = uuid ? `native:${uuid}` : this.fallback([sourceFile, role, timestamp, turnId, requestId, blocks]);
    for (const { text, blockIndex } of blocks) {
      this.result.messages.push({
        id: `${identity}:${blockIndex}`, role, at: timestamp, sourceOrder: lineNumber, blockIndex, text,
        ...(turnId && { turnId }), ...(requestId && { requestId }), ...((cwd || repository || branch) && { context }),
      });
    }
  }

  private fallback(fields: readonly unknown[]): string {
    const hash = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
    const occurrence = (this.occurrences.get(hash) ?? 0) + 1;
    this.occurrences.set(hash, occurrence);
    return `text:${hash}:${occurrence}`;
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
  return /^<(ide_opened_file|ide_selection|session-start-hook|system-reminder|local-command-stdout|local-command-stderr|local-command-caveat)>[\s\S]*<\/\1>$/.test(trimmed)
    || /^<command-name>[^<]*<\/command-name>(?:\s*<command-message>[^<]*<\/command-message>)?(?:\s*<command-args>[\s\S]*<\/command-args>)?$/.test(trimmed);
}

function identifier(value: unknown): string | undefined {
  if (typeof value === "string" && value.length) return value;
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
}
