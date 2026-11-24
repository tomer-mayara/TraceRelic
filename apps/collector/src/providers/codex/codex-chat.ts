import type { CodexRolloutEntry } from "./codex-history.ts";
import type { DamagedLine } from "../../transcript/index.ts";
import type { Metadata, Role } from "../../storage/collector-storage.ts";
import { isRecordedTimestamp } from "@tracerelic/shared";
import { invalidState, jsonDigest, stateRecord, stateString, TextOccurrences } from "../../scan/parser-state.ts";
import type { ChatParser, DecodedChat } from "../../scan/decoded-chat.ts";

type ChatEntry = Pick<CodexRolloutEntry, "sessionId" | "lineNumber" | "timestamp" | "record" | "recordPrefixDigest">;

export class CodexChat implements ChatParser<ChatEntry> {
  private readonly context: Metadata = {};
  private turnId?: string;
  private requestId?: string;
  private paginated = false;
  private restoredThrough = 0;
  private previous?: { position: string; role: Role; turnId?: string };
  private readonly mirrors = new Map<string, MirrorEvidence[]>();
  private readonly occurrences: TextOccurrences;
  private refinements = new Map<string, MirrorRefinement>();

  private constructor(occurrences: TextOccurrences) {
    this.occurrences = occurrences;
  }

  static resume(state?: unknown): CodexChat {
    if (state === undefined) return new CodexChat(new TextOccurrences());
    const saved = stateRecord(state, ["context", "turnId", "requestId", "previous", "mirrors", "occurrences", "paginated"]);
    const chat = new CodexChat(TextOccurrences.restore(saved.occurrences));
    const context = stateRecord(saved.context, ["cwd", "repository", "branch"]);
    for (const key of ["cwd", "repository", "branch"] as const) {
      const value = stateString(context[key]);
      if (value) chat.context[key] = value;
    }
    chat.turnId = stateString(saved.turnId);
    chat.requestId = stateString(saved.requestId);
    if (saved.paginated !== undefined && saved.paginated !== true) invalidState();
    chat.paginated = saved.paginated === true;
    if (saved.previous !== undefined) {
      const { position, role, turnId } = stateRecord(saved.previous, ["position", "role", "turnId"]);
      if (role !== "user" && role !== "assistant") invalidState();
      chat.previous = { position: statePosition(position), role, turnId: stateString(turnId) };
      chat.restoredThrough = Number(chat.previous.position.split(":")[0]);
    }
    for (const [key, rows] of Object.entries(stateRecord(saved.mirrors))) {
      if (!chat.previous || !/^(event|response|joined):[a-f0-9]{64}$/.test(key) || !Array.isArray(rows) || !rows.length) {
        invalidState();
      }
      chat.mirrors.set(key, rows.map(value => {
        const { position, turnId, requestId, messageId, parts, receipt } = stateRecord(value, ["position", "turnId", "requestId", "messageId", "parts", "receipt"]);
        if (parts !== undefined && (!Array.isArray(parts) || !parts.length)) invalidState();
        return {
          position: statePosition(position), turnId: stateString(turnId),
          requestId: stateString(requestId), messageId: stateString(messageId), ...(parts && { parts: parts.map(statePosition) }),
          ...(receipt !== undefined && { receipt: mirrorReceipt(receipt) }),
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
      ...(this.paginated && { paginated: true }),
    };
  }

  /** Read one rollout in the source order supplied by the Codex reader. */
  static decode(entries: readonly ChatEntry[]): DecodedChat {
    return CodexChat.resume().decodeBatch(entries);
  }

  async prepareLookahead(
    first: readonly ChatEntry[], tail: AsyncIterable<{ entries: readonly ChatEntry[]; damagedLines?: readonly DamagedLine[] }>, acceptedLine: number,
    damagedLines?: readonly DamagedLine[],
  ): Promise<void> {
    // Only matcher state participates in this pass. Anonymous IDs are assigned when the owning batch is decoded.
    const probe = new CodexChat(new TextOccurrences());
    Object.assign(probe.context, this.context);
    probe.turnId = this.turnId;
    probe.requestId = this.requestId;
    probe.paginated = this.paginated;
    probe.previous = this.previous && { ...this.previous };
    for (const [key, rows] of this.mirrors) probe.mirrors.set(key, [...rows]);

    const refinements = new Map<string, MirrorRefinement>();
    probe.indexMirrors(first, acceptedLine, refinements, damagedLines);
    for await (const batch of tail) probe.indexMirrors(batch.entries, acceptedLine, refinements, batch.damagedLines);
    this.refinements = refinements;
  }

  private indexMirrors(entries: readonly ChatEntry[], acceptedLine: number, refinements: Map<string, MirrorRefinement>, damaged?: readonly DamagedLine[]): void {
    const firstLine = entries[0]?.lineNumber ?? Infinity;
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
    this.readInOrder(entries, batch, damaged);
  }

  decodeBatch(entries: readonly ChatEntry[], damagedLines?: readonly DamagedLine[]): DecodedChat {
    const items = new Map<string, RecordedItem>();
    const batch: ChatBatch = {
      result: { metadata: {}, messages: [] },
      record: (position, item) => {
        const { role, at, turnId, requestId, blocks } = item;
        const identity = item.nativeId ? `native:${item.nativeId}` : this.occurrences.identify([role, at, turnId, requestId, blocks]);
        items.set(position, { ...item, identity });
      },
      matched: (position, item, event, evidence) => {
        const first = items.get(position);
        if (!first) {
          if (!event && evidence?.receipt && Number(position.split(":")[0]) <= this.restoredThrough) {
            refineAcceptedMirror(batch.result, position, item, evidence.receipt);
          }
          return;
        }
        if (!event) first.blocks = item.blocks;
        mergeMirrorFields(first, item);
      },
    };
    this.readInOrder(entries, batch, damagedLines);
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

  private readInOrder(entries: readonly ChatEntry[], batch: ChatBatch, damaged?: readonly DamagedLine[]): void {
    let gap = 0;
    const forget = () => {
      this.clearMirrors();
      this.turnId = this.requestId = undefined;
      for (const field of ["cwd", "repository", "branch"] as const) delete this.context[field];
    };
    for (const entry of entries) {
      while (damaged && gap < damaged.length && damaged[gap].lineNumber < entry.lineNumber) {
        forget();
        gap++;
      }
      this.read(entry, batch);
    }
    if (damaged && gap < damaged.length) forget();
  }

  private read(entry: ChatEntry, batch: ChatBatch): void {
    const { record, timestamp } = entry;
    const payload = object(record.payload);
    if (!payload) return;
    const passthrough = object(payload.internal_chat_message_metadata_passthrough);
    const turnId = identifier(payload.turn_id, passthrough?.turn_id, record.turn_id);
    const requestId = identifier(payload.request_id, record.request_id);
    if (record.type === "session_meta") {
      if (identifier(payload.id, payload.session_id) === entry.sessionId) {
        this.paginated = payload.history_mode === "paginated";
        this.observeContext(payload, entry, batch.result);
      }
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
    this.readMessage(entry, payload, { timestamp, turnId, requestId }, batch);
  }

  private readMessage(entry: ChatEntry, payload: Fields, identity: { timestamp: string; turnId?: string; requestId?: string }, batch: ChatBatch): void {
    const { timestamp, turnId, requestId } = identity;
    const { record } = entry;
    const event = record.type === "event_msg";
    const item = event && payload.type === "item_completed" ? object(payload.item) : undefined;
    if (this.paginated && !item) return;
    const role = item ? completedRole(item.type) : chatRole(record.type, payload);
    if (!role) return;
    const blocks = item ? completedBlocks(role, item) : visibleBlocks(role, event, payload);
    if (blocks.length === 0) return;
    this.observeContext(payload, entry, batch.result);
    const messageId = identifier(item?.id, object(payload.moderation)?.item_id, payload.message_id, payload.item_id, payload.id, record.message_id);
    const details = {
      role, at: timestamp, sourceOrder: entry.lineNumber,
      prefixDigest: entry.recordPrefixDigest,
      turnId: turnId ?? this.turnId,
      requestId: requestId ?? (!turnId || turnId === this.turnId ? this.requestId : undefined),
      context: Object.keys(this.context).length ? { ...this.context } : undefined,
      messageId, nativeId: messageId ?? identifier(payload.client_id, record.id, record.record_id, payload.record_id, record.uuid),
    };
    // Each assistant block has its own event. One user event joins all the text inputs.
    if (item && this.paginated) {
      batch.record?.(`${entry.lineNumber}:${blocks[0].blockIndex}`, { ...details, blocks });
      return;
    }
    if (role === "assistant" && this.joinedMirror({ ...details, blocks }, event, batch, object(payload.moderation) !== undefined)) return;
    const groups = role === "assistant" ? blocks.map(block => [block]) : [blocks];
    for (const group of groups) this.addItem({ ...details, blocks: group }, event, batch);
  }

  /** A legacy moderated event joins every text part from the same assistant item. */
  private joinedMirror(item: ChatItem, event: boolean, batch: ChatBatch, joinedEvent: boolean): boolean {
    if (event && !joinedEvent || !event && item.blocks.length < 2) return false;
    const digest = jsonDigest(item.blocks.map(block => block.text).join(""));
    const key = `joined:${digest}`;
    if (this.previous?.role !== item.role || disagree(this.previous.turnId, item.turnId)) this.clearMirrors();
    const joined = this.mirrors.get(key) ?? [];
    const match = joined.findIndex(row => Boolean(row.parts) === event
      && !disagree(row.messageId, item.messageId) && !disagree(row.turnId, item.turnId) && !disagree(row.requestId, item.requestId));
    if (match < 0) {
      const positions = item.blocks.map(block => `${item.sourceOrder}:${block.blockIndex}`);
      joined.push({ position: positions[0], messageId: item.messageId, turnId: item.turnId, requestId: item.requestId,
        ...(!event && { parts: positions }) });
      this.mirrors.set(key, joined);
      return false;
    }
    const [row] = joined.splice(match, 1);
    if (!joined.length) this.mirrors.delete(key);
    if (!event) {
      this.addItem(item, false, batch);
    } else {
      const positions = new Set(row.parts);
      for (const [key, rows] of this.mirrors) {
        const remaining = rows.filter(candidate => !positions.has(candidate.position));
        if (remaining.length) this.mirrors.set(key, remaining);
        else this.mirrors.delete(key);
      }
      for (const position of positions) batch.matched(position, item, true);
    }
    return true;
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
      batch.matched(matched.position, item, event, matched);
      return;
    }
    const { role, turnId, requestId, messageId, blocks } = item;
    const position = `${item.sourceOrder}:${blocks[0].blockIndex}`;
    batch.record?.(position, item);
    this.previous = { position, role, turnId };
    const own = `${event ? "event" : "response"}:${digest}`;
    const pending = this.mirrors.get(own);
    const evidence = { position, turnId, requestId, messageId,
      ...(event && item.prefixDigest && { receipt: { at: item.at, digest: item.prefixDigest } }) };
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
  prefixDigest?: string;
  turnId?: string;
  requestId?: string;
  context?: Metadata;
}

interface RecordedItem extends ChatItem {
  identity: string;
}

interface MirrorReceipt { at: string; digest: string }
type MirrorEvidence = Pick<ChatItem, "messageId" | "requestId" | "turnId"> & { position: string; parts?: string[]; receipt?: MirrorReceipt };

type MirrorFields = Pick<ChatItem, "messageId" | "nativeId" | "turnId" | "requestId" | "context">;

interface MirrorRefinement extends MirrorFields {
  layout?: { blockIndex: number; length: number }[];
}

interface ChatBatch {
  result: DecodedChat;
  record?(position: string, item: ChatItem): void;
  matched(position: string, item: ChatItem, event: boolean, evidence?: MirrorEvidence): void;
}

function mirrorReceipt(value: unknown): MirrorReceipt {
  const { at, digest } = stateRecord(value, ["at", "digest"]);
  if (typeof at !== "string" || !isRecordedTimestamp(at) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) return invalidState();
  return { at, digest };
}

function refineAcceptedMirror(chat: DecodedChat, position: string, item: ChatItem, receipt: MirrorReceipt): void {
  if (!item.nativeId) return;
  const sourceOrder = Number(position.split(":")[0]);
  (chat.messageOrigins ??= []).push({ sourceOrder, prefixDigest: receipt.digest, refinesAccepted: true });
  for (const { text, blockIndex } of item.blocks) {
    chat.messages.push({ id: `native:${item.nativeId}:${blockIndex}`, at: receipt.at, role: item.role, text, sourceOrder, blockIndex,
      ...(item.turnId && { turnId: item.turnId }), ...(item.requestId && { requestId: item.requestId }) });
  }
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

function completedRole(type: unknown): Role | undefined {
  if (type === "UserMessage") return "user";
  if (type === "AgentMessage") return "assistant";
}

function completedBlocks(role: Role, item: Fields): TextBlock[] {
  if (!Array.isArray(item.content)) return [];
  if (role === "assistant" && !displaysAnswer(item.moderation)) return [];
  return item.content.flatMap((value, blockIndex) => {
    const part = object(value);
    if (part?.type !== (role === "user" ? "text" : "Text") || typeof part.text !== "string" || !part.text.length) return [];
    return [{ blockIndex, text: part.text }];
  });
}

function displaysAnswer(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  const moderation = object(value);
  if (!moderation || typeof moderation.moderated !== "boolean") return false;
  if (moderation.display === undefined || moderation.display === null) return !moderation.moderated;
  const display = object(moderation.display);
  if (display?.version !== 1 || display.mode !== "show" || (display.trustedContacts !== "check" && display.trustedContacts !== "skip")) return false;
  if (display.annotation === undefined || display.annotation === null) return true;
  const annotation = object(display.annotation);
  return annotation?.kind === "wellbeingHelpline" && (annotation.subject === "prompt" || annotation.subject === "answer");
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
