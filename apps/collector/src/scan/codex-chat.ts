import { createHash } from "node:crypto";
import type { CodexRolloutEntry } from "../history/index.ts";
import type { BranchObservation, Message, Metadata, Role } from "../storage/collector-storage.ts";

type PositionedMessage = Message & { sourceOrder: number; blockIndex: number };
type ChatEntry = Pick<CodexRolloutEntry, "sessionId" | "lineNumber" | "timestamp" | "record">;

interface DecodedChat {
  messages: PositionedMessage[];
  metadata: Metadata;
  branchObservation?: BranchObservation;
}

export class CodexChat {
  private readonly context: Metadata = {};
  private lastBranch?: string;
  private branchObservation?: BranchObservation;
  private turnId?: string;
  private requestId?: string;
  private readonly items: RecordedItem[] = [];
  private readonly events = new Map<string, RecordedItem[]>();
  private readonly responses = new Map<string, RecordedItem[]>();
  private readonly occurrences = new Map<string, number>();

  private constructor() {}

  /** Read one rollout in the source order supplied by the Codex reader. */
  static decode(entries: readonly ChatEntry[]): DecodedChat {
    const chat = new CodexChat();
    for (const entry of entries) chat.read(entry);
    return {
      messages: chat.messages(),
      metadata: { ...chat.context, ...(chat.lastBranch && { branch: chat.lastBranch }) },
      ...(chat.branchObservation && { branchObservation: chat.branchObservation }),
    };
  }

  private read(entry: ChatEntry): void {
    const { record, timestamp } = entry;
    const payload = object(record.payload);
    if (!payload) return;
    const passthrough = object(payload.internal_chat_message_metadata_passthrough);
    const turnId = identifier(payload.turn_id, passthrough?.turn_id, record.turn_id);
    const requestId = identifier(payload.request_id, record.request_id);
    if (record.type === "session_meta") {
      if (identifier(payload.id, payload.session_id) === entry.sessionId) this.observeContext(payload, entry);
      return;
    }
    const event = record.type === "event_msg";
    if (record.type === "turn_context" || (event && payload.type === "task_started")) {
      if (!turnId || turnId !== this.turnId) {
        this.clearMirrors();
        this.requestId = undefined;
      }
      this.turnId = turnId;
      this.requestId = requestId ?? this.requestId;
      this.observeContext(payload, entry);
      return;
    }
    if (event && (payload.type === "task_complete" || payload.type === "turn_aborted")) {
      this.clearMirrors();
      this.turnId = this.requestId = undefined;
      return;
    }
    if (!timestamp) return;

    const role = chatRole(record.type, payload);
    if (!role) return;
    const blocks = visibleBlocks(role, event, payload);
    if (blocks.length === 0) return;
    this.observeContext(payload, entry);
    const messageId = identifier(payload.message_id, payload.item_id, payload.id, record.message_id);
    const details = {
      role, at: timestamp, sourceOrder: entry.lineNumber,
      turnId: turnId ?? this.turnId,
      requestId: requestId ?? (!turnId || turnId === this.turnId ? this.requestId : undefined),
      context: Object.keys(this.context).length ? { ...this.context } : undefined,
      messageId, nativeId: messageId ?? identifier(payload.client_id, record.id, record.record_id, payload.record_id, record.uuid),
    };
    // Each assistant block has its own event. One user event joins all the text inputs.
    const groups = role === "assistant" ? blocks.map(block => [block]) : [blocks];
    for (const group of groups) this.addItem({ ...details, blocks: group }, event);
  }

  private observeContext(payload: Fields, entry: ChatEntry): void {
    const git = object(payload.git);
    const cwd = identifier(payload.cwd);
    const repository = identifier(git?.repository_url, payload.repository_url, payload.repository);
    const branch = identifier(git?.branch, payload.branch);
    if (cwd) this.context.cwd = cwd;
    if (disagree(repository, this.context.repository) || git?.branch === null) delete this.context.branch;
    if (repository) this.context.repository = repository;
    if (branch) {
      this.context.branch = this.lastBranch = branch;
      this.branchObservation = { sourceOrder: entry.lineNumber, ...(entry.timestamp && { at: entry.timestamp }) };
    }
  }

  private clearMirrors(): void {
    this.events.clear();
    this.responses.clear();
  }

  private addItem(item: ChatItem, event: boolean): void {
    const previous = this.items.at(-1);
    if (previous && (previous.role !== item.role || disagree(previous.turnId, item.turnId))) this.clearMirrors();
    const text = item.blocks.map(block => block.text).join("");
    const opposite = event ? this.responses : this.events;
    const candidates = opposite.get(text);
    const match = candidates?.findIndex(other => !disagree(other.turnId, item.turnId)
      && !disagree(other.messageId, item.messageId) && !disagree(other.requestId, item.requestId)) ?? -1;
    if (candidates && match !== -1) {
      const [first] = candidates.splice(match, 1);
      if (!candidates.length) opposite.delete(text);
      // A later typed copy can supply block positions or IDs absent from the first event.
      if (!event) first.blocks = item.blocks;
      const nativeId = first.messageId ?? item.messageId ?? first.nativeId ?? item.nativeId;
      if (nativeId) first.identity = `native:${nativeId}`;
      first.turnId ??= item.turnId;
      first.requestId ??= item.requestId;
      if (item.context) first.context = { ...item.context, ...first.context };
      return;
    }
    const identity = item.nativeId ? `native:${item.nativeId}` : this.fallbackIdentity(item);
    const recorded = { ...item, identity };
    this.items.push(recorded);
    const own = event ? this.events : this.responses;
    const pending = own.get(text);
    if (pending) pending.push(recorded);
    else own.set(text, [recorded]);
  }

  private fallbackIdentity({ role, at, turnId, requestId, blocks }: ChatItem): string {
    // Count at the first observation so a later mirror cannot renumber other prompts.
    const fields = JSON.stringify([role, at, turnId, requestId, blocks]);
    const digest = createHash("sha256").update(fields).digest("hex");
    const occurrence = (this.occurrences.get(digest) ?? 0) + 1;
    this.occurrences.set(digest, occurrence);
    return `text:${digest}:${occurrence}`;
  }

  private messages(): PositionedMessage[] {
    const messages: PositionedMessage[] = [];
    for (const { blocks, identity, at, sourceOrder, role, turnId, requestId, context } of this.items) {
      for (const { blockIndex, text } of blocks) {
        messages.push({
          id: `${identity}:${blockIndex}`, at, role, text, sourceOrder, blockIndex,
          ...(turnId && { turnId }), ...(requestId && { requestId }), ...(context && { context }),
        });
      }
    }
    return messages;
  }
}

type Fields = Readonly<Record<string, unknown>>;
type TextBlock = { text: string; blockIndex: number };
interface ChatItem {
  blocks: TextBlock[];
  role: Role;
  at: string;
  sourceOrder: number;
  messageId?: string;
  nativeId?: string;
  turnId?: string;
  requestId?: string;
  context?: Metadata;
}

interface RecordedItem extends ChatItem {
  identity: string;
}

function object(value: unknown): Fields | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Fields;
}

function identifier(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function disagree(first?: string, second?: string): boolean {
  return first !== undefined && second !== undefined && first !== second;
}

function chatRole(type: unknown, payload: Fields): Role | undefined {
  if (type === "event_msg") {
    if (payload.type === "user_message") return "user";
    if (payload.type === "agent_message") return "assistant";
  }
  if (type === "response_item" && payload.type === "message" && payload.channel !== "analysis"
    && (payload.role === "user" || payload.role === "assistant")) return payload.role;
}

function visibleBlocks(role: Role, event: boolean, payload: Fields): TextBlock[] {
  if (event) {
    const text = payload.message;
    if (typeof text !== "string" || !text.length || (role === "user" && injectedUserText(text))) return [];
    return [{ text, blockIndex: 0 }];
  }
  const content = payload.content;
  if (!Array.isArray(content)) return [];
  const kinds = object(payload.internal_chat_message_metadata_passthrough)?.content_item_kinds;
  const blocks: TextBlock[] = [];
  for (const [blockIndex, part] of content.entries()) {
    const block = object(part);
    if (block?.type !== (role === "user" ? "input_text" : "output_text")) continue;
    const text = block.text;
    if (typeof text !== "string" || !text.length) continue;
    const kind = Array.isArray(kinds) ? kinds[blockIndex] : undefined;
    if (role === "user" && (injectedUserText(text, kind) || mediaLabel(text, content, blockIndex))) continue;
    blocks.push({ text, blockIndex });
  }
  return blocks;
}

function injectedUserText(text: string, kind?: unknown): boolean {
  // Codex marks text supplied by a user explicitly. Legacy records need the envelope check.
  if (typeof kind === "string" && kind && kind !== "unknown") return kind !== "user.text";
  const trimmed = text.trim();
  return /^<(environment_context|user_instructions|skill|subagent_notification|user_shell_command|codex_internal_context|goal_context|recommended_plugins)(?: [^>]*)?>[\s\S]*<\/\1>$/i.test(trimmed)
    || /^# AGENTS\.md instructions(?: for [^\r\n]+)?\r?\n\s*<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>(?:\s*<environment_context>[\s\S]*<\/environment_context>)?$/.test(trimmed);
}

function mediaLabel(text: string, content: readonly unknown[], index: number): boolean {
  const next = object(content[index + 1])?.type;
  const previous = object(content[index - 1])?.type;
  return (next === "input_image" && /^<image(?: name=[^>]+)?>$/.test(text))
    || (previous === "input_image" && text === "</image>")
    || (next === "input_audio" && /^<audio(?: name=[^>]+)?>$/.test(text))
    || (previous === "input_audio" && text === "</audio>");
}
