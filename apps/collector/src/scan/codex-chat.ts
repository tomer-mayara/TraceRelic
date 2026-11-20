import type { CodexRolloutEntry, RecordBatch } from "../history/index.ts";
import type { Metadata, Role } from "../storage/collector-storage.ts";
import { invalidState, jsonDigest, stateRecord, stateString, TextOccurrences } from "./chat-parser-state.ts";
import type { ChatParser, DecodedChat } from "./decoded-chat.ts";

type ChatEntry = Pick<CodexRolloutEntry, "sessionId" | "lineNumber" | "timestamp" | "record">;

export class CodexChat implements ChatParser<ChatEntry> {
  private readonly context: Metadata = {};
  private turnId?: string;
  private requestId?: string;
  private previous?: { position: string; role: Role; turnId?: string };
  private readonly mirrors = new Map<string, MirrorEvidence[]>();
  private readonly occurrences: TextOccurrences;
  private refinements = new Map<string, MirrorRefinement>();

  private constructor(occurrences: TextOccurrences) {
    this.occurrences = occurrences;
  }

  static resume(state?: unknown): CodexChat {
    if (state === undefined) return new CodexChat(new TextOccurrences());
    const saved = stateRecord(state, ["context", "turnId", "requestId", "previous", "mirrors", "occurrences"]);
    const chat = new CodexChat(TextOccurrences.restore(saved.occurrences));
    const context = stateRecord(saved.context, ["cwd", "repository", "branch"]);
    for (const key of ["cwd", "repository", "branch"] as const) {
      const value = stateString(context[key]);
      if (value) chat.context[key] = value;
    }
    chat.turnId = stateString(saved.turnId);
    chat.requestId = stateString(saved.requestId);
    if (saved.previous !== undefined) {
      const { position, role, turnId } = stateRecord(saved.previous, ["position", "role", "turnId"]);
      if (role !== "user" && role !== "assistant") invalidState();
      chat.previous = { position: statePosition(position), role, turnId: stateString(turnId) };
    }
    for (const [key, rows] of Object.entries(stateRecord(saved.mirrors))) {
      if (!chat.previous || !/^(event|response):[a-f0-9]{64}$/.test(key) || !Array.isArray(rows) || !rows.length) {
        invalidState();
      }
      chat.mirrors.set(key, rows.map(value => {
        const { position, turnId, requestId, messageId } = stateRecord(value, ["position", "turnId", "requestId", "messageId"]);
        return {
          position: statePosition(position), turnId: stateString(turnId),
          requestId: stateString(requestId), messageId: stateString(messageId),
        };
      }));
    }
    return chat;
  }

  snapshot(): object {
    const mirrors = Object.fromEntries(Array.from(this.mirrors, ([key, rows]) => [key, rows.map(row => ({ ...row }))]));
    return {
      context: { ...this.context }, turnId: this.turnId, requestId: this.requestId,
      previous: this.previous && { ...this.previous }, occurrences: this.occurrences.snapshot(), mirrors,
    };
  }

  /** Read one rollout in the source order supplied by the Codex reader. */
  static decode(entries: readonly ChatEntry[]): DecodedChat {
    return CodexChat.resume().decodeBatch(entries);
  }

  async prepareLookahead(
    first: readonly ChatEntry[], tail: AsyncIterable<Pick<RecordBatch<ChatEntry>, "entries">>, acceptedLine: number,
  ): Promise<void> {
    // Only matcher state participates in this pass. Anonymous IDs are assigned when the owning batch is decoded.
    const probe = new CodexChat(new TextOccurrences());
    Object.assign(probe.context, this.context);
    probe.turnId = this.turnId;
    probe.requestId = this.requestId;
    probe.previous = this.previous && { ...this.previous };
    for (const [key, rows] of this.mirrors) probe.mirrors.set(key, [...rows]);

    const refinements = new Map<string, MirrorRefinement>();
    probe.indexMirrors(first, acceptedLine, refinements);
    for await (const { entries } of tail) probe.indexMirrors(entries, acceptedLine, refinements);
    this.refinements = refinements;
  }

  private indexMirrors(entries: readonly ChatEntry[], acceptedLine: number, refinements: Map<string, MirrorRefinement>): void {
    if (!entries.length) return;
    const firstLine = entries[0].lineNumber;
    const batch: ChatBatch = {
      result: { messages: [], metadata: {} },
      matched(position, item, event) {
        const line = Number(position.split(":")[0]);
        if (line <= acceptedLine || line >= firstLine) return;
        const { messageId, nativeId, turnId, requestId, context } = item;
        refinements.set(position, {
          messageId, nativeId, turnId, requestId, context,
          layout: event ? undefined : item.blocks.map(({ blockIndex, text }) => ({ blockIndex, length: text.length })),
        });
      },
    };
    for (const entry of entries) this.read(entry, batch);
  }

  decodeBatch(entries: readonly ChatEntry[]): DecodedChat {
    const items = new Map<string, RecordedItem>();
    const batch: ChatBatch = {
      result: { metadata: {}, messages: [] },
      record: (position, item) => {
        const { role, at, turnId, requestId, blocks } = item;
        const identity = item.nativeId ? `native:${item.nativeId}` : this.occurrences.identify([role, at, turnId, requestId, blocks]);
        items.set(position, { ...item, identity });
      },
      matched(position, item, event) {
        const first = items.get(position);
        if (!first) return;
        if (!event) first.blocks = item.blocks;
        mergeMirrorFields(first, item);
      },
    };
    for (const entry of entries) this.read(entry, batch);
    for (const [position, item] of items) {
      const refinement = this.refinements.get(position);
      if (refinement) {
        applyRefinement(item, refinement);
        this.refinements.delete(position);
      }
      const { blocks, identity, at, sourceOrder, role, turnId, requestId, context } = item;
      for (const { blockIndex, text } of blocks) {
        batch.result.messages.push({
          id: `${identity}:${blockIndex}`, at, role, text, sourceOrder, blockIndex,
          ...(turnId && { turnId }), ...(requestId && { requestId }), ...(context && { context }),
        });
      }
    }
    return batch.result;
  }

  private read(entry: ChatEntry, batch: ChatBatch): void {
    const { record, timestamp } = entry;
    const payload = object(record.payload);
    if (!payload) return;
    const passthrough = object(payload.internal_chat_message_metadata_passthrough);
    const turnId = identifier(payload.turn_id, passthrough?.turn_id, record.turn_id);
    const requestId = identifier(payload.request_id, record.request_id);
    if (record.type === "session_meta") {
      if (identifier(payload.id, payload.session_id) === entry.sessionId) this.observeContext(payload, entry, batch.result);
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
      this.observeContext(payload, entry, batch.result);
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
    this.observeContext(payload, entry, batch.result);
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
    for (const group of groups) this.addItem({ ...details, blocks: group }, event, batch);
  }

  private observeContext(payload: Fields, entry: ChatEntry, result: DecodedChat): void {
    const git = object(payload.git);
    const cwd = identifier(payload.cwd);
    const repository = identifier(git?.repository_url, payload.repository_url, payload.repository);
    const branch = identifier(git?.branch, payload.branch);
    if (cwd) this.context.cwd = result.metadata.cwd = cwd;
    if (disagree(repository, this.context.repository) || git?.branch === null) delete this.context.branch;
    if (repository) this.context.repository = result.metadata.repository = repository;
    if (branch) {
      this.context.branch = result.metadata.branch = branch;
      result.branchObservation = { sourceOrder: entry.lineNumber, ...(entry.timestamp && { at: entry.timestamp }) };
    }
  }

  private clearMirrors(): void {
    this.mirrors.clear();
    this.previous = undefined;
  }

  private addItem(item: ChatItem, event: boolean, batch: ChatBatch): void {
    const previous = this.previous;
    if (previous && (previous.role !== item.role || disagree(previous.turnId, item.turnId))) this.clearMirrors();
    const digest = jsonDigest(item.blocks.map(block => block.text).join(""));
    const opposite = `${event ? "response" : "event"}:${digest}`;
    const candidates = this.mirrors.get(opposite);
    const match = candidates?.findIndex(other => !disagree(other.turnId, item.turnId)
      && !disagree(other.messageId, item.messageId) && !disagree(other.requestId, item.requestId)) ?? -1;
    if (candidates && match !== -1) {
      const [matched] = candidates.splice(match, 1);
      if (!candidates.length) this.mirrors.delete(opposite);
      if (previous?.position === matched.position) previous.turnId ??= item.turnId;
      batch.matched(matched.position, item, event);
      return;
    }
    const { role, turnId, requestId, messageId, blocks } = item;
    const position = `${item.sourceOrder}:${blocks[0].blockIndex}`;
    batch.record?.(position, item);
    this.previous = { position, role, turnId };
    const own = `${event ? "event" : "response"}:${digest}`;
    const pending = this.mirrors.get(own);
    const evidence = { position, turnId, requestId, messageId };
    if (pending) pending.push(evidence);
    else this.mirrors.set(own, [evidence]);
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

type MirrorEvidence = Pick<ChatItem, "messageId" | "requestId" | "turnId"> & { position: string };

type MirrorFields = Pick<ChatItem, "messageId" | "nativeId" | "turnId" | "requestId" | "context">;

interface MirrorRefinement extends MirrorFields {
  layout?: { blockIndex: number; length: number }[];
}

interface ChatBatch {
  result: DecodedChat;
  record?(position: string, item: ChatItem): void;
  matched(position: string, item: ChatItem, event: boolean): void;
}

function mergeMirrorFields(first: RecordedItem, other: MirrorFields): void {
  const nativeId = first.messageId ?? other.messageId ?? first.nativeId ?? other.nativeId;
  if (nativeId) first.identity = `native:${nativeId}`;
  first.turnId ??= other.turnId;
  first.requestId ??= other.requestId;
  if (other.context) first.context = { ...other.context, ...first.context };
}

function applyRefinement(first: RecordedItem, refinement: MirrorRefinement): void {
  if (refinement.layout) {
    // A user event joins its typed blocks. The recorded UTF-16 lengths also preserve surrogate pairs at block edges.
    const text = first.blocks[0].text;
    let offset = 0;
    first.blocks = refinement.layout.map(({ length, blockIndex }) => {
      const block = { text: text.slice(offset, offset + length), blockIndex };
      offset += length;
      return block;
    });
  }
  mergeMirrorFields(first, refinement);
}

function statePosition(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*:[0-9]+$/.test(value)) invalidState();
  return value;
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
