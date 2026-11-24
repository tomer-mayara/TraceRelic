import type { CodexRolloutEntry } from "./codex-history.ts";
import type { DamagedLine } from "../../transcript/index.ts";
import { JsonRecord } from "../../transcript/json-record.ts";
import type { Metadata, Role } from "../../storage/collector-storage.ts";
import { isRecordedTimestamp } from "@tracerelic/shared";
import { ParserState, TextOccurrences } from "../../scan/parser-state.ts";
import type { ChatParser, DecodedChat } from "../../scan/decoded-chat.ts";
import { CodexVisibleText, type TextBlock } from "./codex-visible-text.ts";

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
    const saved = ParserState.record(state, ["context", "turnId", "requestId", "previous", "mirrors", "occurrences", "paginated"]);
    const chat = new CodexChat(TextOccurrences.restore(saved.occurrences));
    const context = ParserState.record(saved.context, ["cwd", "repository", "branch"]);
    for (const key of ["cwd", "repository", "branch"] as const) {
      const value = ParserState.string(context[key]);
      if (value) chat.context[key] = value;
    }
    chat.turnId = ParserState.string(saved.turnId);
    chat.requestId = ParserState.string(saved.requestId);
    if (saved.paginated !== undefined && saved.paginated !== true) ParserState.invalid();
    chat.paginated = saved.paginated === true;
    if (saved.previous !== undefined) {
      const { position, role, turnId } = ParserState.record(saved.previous, ["position", "role", "turnId"]);
      if (role !== "user" && role !== "assistant") ParserState.invalid();
      chat.previous = { position: CodexChat.statePosition(position), role, turnId: ParserState.string(turnId) };
      chat.restoredThrough = Number(chat.previous.position.split(":")[0]);
    }
    for (const [key, rows] of Object.entries(ParserState.record(saved.mirrors))) {
      if (!chat.previous || !/^(event|response|joined):[a-f0-9]{64}$/.test(key) || !Array.isArray(rows) || !rows.length) {
        ParserState.invalid();
      }
      chat.mirrors.set(key, rows.map(value => {
        const { position, turnId, requestId, messageId, parts, receipt } = ParserState.record(value, ["position", "turnId", "requestId", "messageId", "parts", "receipt"]);
        if (parts !== undefined && (!Array.isArray(parts) || !parts.length)) ParserState.invalid();
        return {
          position: CodexChat.statePosition(position), turnId: ParserState.string(turnId),
          requestId: ParserState.string(requestId), messageId: ParserState.string(messageId), ...(parts && { parts: parts.map(CodexChat.statePosition) }),
          ...(receipt !== undefined && { receipt: CodexChat.mirrorReceipt(receipt) }),
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
            CodexChat.refineAcceptedMirror(batch.result, position, item, evidence.receipt);
          }
          return;
        }
        if (!event) first.blocks = item.blocks;
        CodexChat.mergeMirrorFields(first, item);
      },
    };
    this.readInOrder(entries, batch, damagedLines);
    for (const [position, item] of items) {
      const refinement = this.refinements.get(position);
      if (refinement) {
        CodexChat.applyRefinement(item, refinement);
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
    const payload = JsonRecord.object(record.payload);
    if (!payload) return;
    const passthrough = JsonRecord.object(payload.internal_chat_message_metadata_passthrough);
    const turnId = JsonRecord.identifier(payload.turn_id, passthrough?.turn_id, record.turn_id);
    const requestId = JsonRecord.identifier(payload.request_id, record.request_id);
    if (record.type === "session_meta") {
      if (JsonRecord.identifier(payload.id, payload.session_id) === entry.sessionId) {
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
    const item = event && payload.type === "item_completed" ? JsonRecord.object(payload.item) : undefined;
    if (this.paginated && !item) return;
    const role = item ? CodexVisibleText.completedRole(item.type) : CodexVisibleText.role(record.type, payload);
    if (!role) return;
    const blocks = item ? CodexVisibleText.completedBlocks(role, item) : CodexVisibleText.blocks(role, event, payload);
    if (blocks.length === 0) return;
    this.observeContext(payload, entry, batch.result);
    const messageId = JsonRecord.identifier(item?.id, JsonRecord.object(payload.moderation)?.item_id, payload.message_id, payload.item_id, payload.id, record.message_id);
    const details = {
      role, at: timestamp, sourceOrder: entry.lineNumber,
      prefixDigest: entry.recordPrefixDigest,
      turnId: turnId ?? this.turnId,
      requestId: requestId ?? (!turnId || turnId === this.turnId ? this.requestId : undefined),
      context: Object.keys(this.context).length ? { ...this.context } : undefined,
      messageId, nativeId: messageId ?? JsonRecord.identifier(payload.client_id, record.id, record.record_id, payload.record_id, record.uuid),
    };
    // Each assistant block has its own event. One user event joins all the text inputs.
    if (item && this.paginated) {
      batch.record?.(`${entry.lineNumber}:${blocks[0].blockIndex}`, { ...details, blocks });
      return;
    }
    if (role === "assistant" && this.joinedMirror({ ...details, blocks }, event, batch, JsonRecord.object(payload.moderation) !== undefined)) return;
    const groups = role === "assistant" ? blocks.map(block => [block]) : [blocks];
    for (const group of groups) this.addItem({ ...details, blocks: group }, event, batch);
  }

  /** A legacy moderated event joins every text part from the same assistant item. */
  private joinedMirror(item: ChatItem, event: boolean, batch: ChatBatch, joinedEvent: boolean): boolean {
    if (event && !joinedEvent || !event && item.blocks.length < 2) return false;
    const digest = ParserState.digest(item.blocks.map(block => block.text).join(""));
    const key = `joined:${digest}`;
    if (this.previous?.role !== item.role || CodexChat.disagree(this.previous.turnId, item.turnId)) this.clearMirrors();
    const joined = this.mirrors.get(key) ?? [];
    const match = joined.findIndex(row => Boolean(row.parts) === event
      && !CodexChat.disagree(row.messageId, item.messageId) && !CodexChat.disagree(row.turnId, item.turnId) && !CodexChat.disagree(row.requestId, item.requestId));
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
    const git = JsonRecord.object(payload.git);
    const cwd = JsonRecord.identifier(payload.cwd);
    const repository = JsonRecord.identifier(git?.repository_url, payload.repository_url, payload.repository);
    const branch = JsonRecord.identifier(git?.branch, payload.branch);
    if (cwd) this.context.cwd = result.metadata.cwd = cwd;
    if (CodexChat.disagree(repository, this.context.repository) || git?.branch === null) delete this.context.branch;
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
    if (previous && (previous.role !== item.role || CodexChat.disagree(previous.turnId, item.turnId))) this.clearMirrors();
    const digest = ParserState.digest(item.blocks.map(block => block.text).join(""));
    const opposite = `${event ? "response" : "event"}:${digest}`;
    const candidates = this.mirrors.get(opposite);
    const match = candidates?.findIndex(other => !CodexChat.disagree(other.turnId, item.turnId)
      && !CodexChat.disagree(other.messageId, item.messageId) && !CodexChat.disagree(other.requestId, item.requestId)) ?? -1;
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

  private static mirrorReceipt(value: unknown): MirrorReceipt {
    const { at, digest } = ParserState.record(value, ["at", "digest"]);
    if (typeof at !== "string" || !isRecordedTimestamp(at) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) return ParserState.invalid();
    return { at, digest };
  }

  private static refineAcceptedMirror(chat: DecodedChat, position: string, item: ChatItem, receipt: MirrorReceipt): void {
    if (!item.nativeId) return;
    const sourceOrder = Number(position.split(":")[0]);
    (chat.messageOrigins ??= []).push({ sourceOrder, prefixDigest: receipt.digest, refinesAccepted: true });
    for (const { text, blockIndex } of item.blocks) {
      chat.messages.push({ id: `native:${item.nativeId}:${blockIndex}`, at: receipt.at, role: item.role, text, sourceOrder, blockIndex,
        ...(item.turnId && { turnId: item.turnId }), ...(item.requestId && { requestId: item.requestId }) });
    }
  }

  private static mergeMirrorFields(first: RecordedItem, other: MirrorFields): void {
    const nativeId = first.messageId ?? other.messageId ?? first.nativeId ?? other.nativeId;
    if (nativeId) first.identity = `native:${nativeId}`;
    first.turnId ??= other.turnId;
    first.requestId ??= other.requestId;
    if (other.context) first.context = { ...other.context, ...first.context };
  }

  private static applyRefinement(first: RecordedItem, refinement: MirrorRefinement): void {
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
    CodexChat.mergeMirrorFields(first, refinement);
  }

  private static statePosition(value: unknown): string {
    if (typeof value !== "string" || !/^[1-9][0-9]*:[0-9]+$/.test(value)) ParserState.invalid();
    return value;
  }

  private static disagree(first?: string, second?: string): boolean {
    return first !== undefined && second !== undefined && first !== second;
  }
}

type Fields = Readonly<Record<string, unknown>>;
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
