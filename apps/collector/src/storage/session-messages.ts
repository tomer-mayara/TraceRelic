import { isRecordedTimestamp } from "@tracerelic/shared";
import type { Batch, Message } from "./collector-storage.ts";
import { BatchValues } from "./batch-values.ts";
import { SessionMetadata } from "./session-metadata.ts";

interface StoredMessage {
  streamId: string;
  value: Message;
}

interface MessageWrite {
  stream: string;
  generation: number;
  path: string;
  rows: Message[];
  origins: NonNullable<Batch["messageOrigins"]>;
}

interface MessageGeneration {
  stream: string;
  generation: number;
  messages: SessionMessages;
}

interface History {
  write: MessageWrite;
  prior?: History;
}

/** Track which source generation supplied each visible occurrence so a verified re-read can correct it. */
export class SessionMessages {
  private readonly records: Map<string, StoredMessage>;
  private readonly proofs: Map<string, { ids: string[]; stream: string; generation: number }>;
  private readonly aliases: Map<string, string>;
  private history?: History;

  private constructor(previous?: SessionMessages) {
    this.records = new Map(previous?.records);
    this.proofs = new Map(previous?.proofs);
    this.aliases = new Map(previous?.aliases);
    this.history = previous?.history;
  }

  private static hasValidMessage(message: Message): boolean {
    return BatchValues.isRecord(message) && BatchValues.isIdentifier(message.id) && isRecordedTimestamp(message.at)
      && (message.role === "user" || message.role === "assistant")
      && typeof message.text === "string"
      && (message.sourceOrder === undefined || (BatchValues.isCount(message.sourceOrder) && message.sourceOrder > 0))
      && (message.blockIndex === undefined || BatchValues.isCount(message.blockIndex))
      && (message.turnId === undefined || BatchValues.isIdentifier(message.turnId))
      && (message.requestId === undefined || BatchValues.isIdentifier(message.requestId))
      && SessionMetadata.isValid(message.context);
  }

  private static conflictingFields<T extends object>(known: T, incoming: T): boolean {
    for (const key in incoming) {
      if (known[key] !== undefined && incoming[key] !== undefined && known[key] !== incoming[key]) return true;
    }
    return false;
  }

  private static replayMessage(known: StoredMessage, incoming: Message, streamId: string): StoredMessage | null {
    const { sourceOrder, blockIndex, context, ...fields } = incoming;
    const previous = known.value;
    if (SessionMessages.conflictingFields(previous, fields) || SessionMessages.conflictingFields(previous.context ?? {}, context ?? {})) return null;
    const value = { ...fields, ...previous };
    if (context) value.context = { ...context, ...previous.context };
    const positioned = previous.sourceOrder !== undefined || previous.blockIndex !== undefined;
    const sameRecord = sourceOrder === undefined || previous.sourceOrder === undefined || sourceOrder === previous.sourceOrder;
    if (!positioned || (streamId === known.streamId && sameRecord)) {
      if (sourceOrder !== undefined) value.sourceOrder ??= sourceOrder;
      if (blockIndex !== undefined) value.blockIndex ??= blockIndex;
    }
    return { streamId: positioned ? known.streamId : streamId, value };
  }

  private static orderedMessages(records: Map<string, StoredMessage>): Message[] {
    const messages: Message[] = [];
    const positions = new Map<string, number[]>();
    for (const { streamId, value } of records.values()) {
      if (value.sourceOrder !== undefined) {
        const slots = positions.get(streamId) ?? [];
        slots.push(messages.length);
        positions.set(streamId, slots);
      }
      messages.push(value);
    }
    // Order only the slots whose records share a source. Leave unrelated and unpositioned messages in place.
    for (const slots of positions.values()) {
      const ordered = slots.map(slot => messages[slot]).sort((left, right) =>
        (left.sourceOrder ?? 0) - (right.sourceOrder ?? 0) || (left.blockIndex ?? 0) - (right.blockIndex ?? 0));
      slots.forEach((slot, index) => { messages[slot] = ordered[index]; });
    }
    return messages;
  }

  private static groupOccurrences(write: MessageWrite): Map<string | number, Message[]> | undefined {
    const origins = new Map<number, string>();
    for (const origin of write.origins) {
      if (!BatchValues.isRecord(origin) || !BatchValues.isCount(origin.sourceOrder) || origin.sourceOrder < 1 || origins.has(origin.sourceOrder)
        || typeof origin.prefixDigest !== "string" || !/^[a-f0-9]{64}$/.test(origin.prefixDigest)
        || (origin.refinesAccepted !== undefined && origin.refinesAccepted !== true)) return;
      origins.set(origin.sourceOrder, JSON.stringify([write.path, origin.prefixDigest]));
    }
    const groups = new Map<string | number, Message[]>();
    for (const row of write.rows) {
      if (!SessionMessages.hasValidMessage(row)) return;
      const proof = row.sourceOrder !== undefined && origins.get(row.sourceOrder);
      const key = proof || groups.size;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    if (origins.size !== [...groups.keys()].filter(key => typeof key === "string").length) return;
    return groups;
  }

  ordered(): Message[] { return SessionMessages.orderedMessages(this.records); }

  static apply(previous: SessionMessages | undefined, batch: Batch, stream: string, generation: number): SessionMessages | null {
    const location = batch.sourceObservation?.location;
    const path = location?.path ?? batch.source.streamId;
    const write = { stream, generation, path: location && /^(?:[a-z]:[\\/]|\\\\)/i.test(location.root) ? path.replaceAll("\\", "/").toLowerCase() : path,
      rows: batch.messages, origins: batch.messageOrigins ?? [] };
    if (!Array.isArray(write.origins) || !Array.isArray(write.rows)) return null;
    if (!batch.repairEvidenceFrom) {
      if (!write.rows.length && !write.origins.length) return previous ?? new SessionMessages();
      const next = new SessionMessages(previous);
      return next.accept(write) ? next : null;
    }
    return (previous ?? new SessionMessages()).replaceGeneration(stream, generation, write);
  }

  /** A newer session must already contain every old occurrence at its recorded position. */
  withoutCorroborated({ stream, generation }: Pick<MessageGeneration, "stream" | "generation">, throughLine: number, peer: MessageGeneration) {
    const key = (row: Message) => JSON.stringify([row.sourceOrder, row.blockIndex, row.role, row.at, row.text]);
    const indexed = new Set<string>();
    for (let node = peer.messages.history; node; node = node.prior) {
      if (node.write.stream === peer.stream && node.write.generation === peer.generation) {
        for (const row of node.write.rows) indexed.add(key(row));
      }
    }
    const occurrences = new Map<string, string>();
    for (let node = this.history; node; node = node.prior) {
      if (node.write.stream !== stream || node.write.generation !== generation) continue;
      for (const row of node.write.rows) {
        const occurrence = key(row);
        if (!row.sourceOrder || row.sourceOrder > throughLine || row.blockIndex === undefined || !indexed.has(occurrence)) return;
        const id = occurrences.get(occurrence);
        if (id && id !== row.id) return;
        occurrences.set(occurrence, row.id);
      }
    }
    return this.replaceGeneration(stream, generation);
  }

  private replaceGeneration(stream: string, generation: number, write?: MessageWrite): SessionMessages | null {
    const retained: MessageWrite[] = [];
    for (let node = this.history; node; node = node.prior) retained.push(node.write);
    const next = new SessionMessages();
    let replaced = false;
    for (const old of retained.reverse()) {
      if (old.stream === stream && old.generation === generation) {
        if (!replaced && write && !next.accept(write)) return null;
        replaced = true;
      } else if (!next.accept(old)) return null;
    }
    return replaced || !write || next.accept(write) ? next : null;
  }

  /** Two decoders can describe the same original line as joined text or as native blocks. */
  private reconcileBlocks(ids: string[], rows: Message[], stream: string): boolean {
    const known = ids.map(id => this.records.get(id)).filter((item): item is StoredMessage => !!item);
    if (known.length !== ids.length || !known.length) return false;
    const first = known[0].value;
    if (rows.some(row => row.role !== first.role || row.at !== first.at)
      || known.some(row => row.value.role !== first.role || row.value.at !== first.at)
      || known.map(row => row.value.text).join("") !== rows.map(row => row.text).join("")) return false;
    for (const row of rows) {
      const id = this.aliases.get(row.id) ?? row.id;
      if (this.records.has(id) && !ids.includes(id)) return false;
    }
    if (known.length === rows.length || rows.length === 1) return this.enrichBlocks(known, rows, stream);
    if (known.length !== 1 || new Set(rows.map(row => row.id)).size !== rows.length) return false;
    return this.splitJoined(known[0], rows, stream);
  }

  private enrichBlocks(known: StoredMessage[], rows: Message[], stream: string): boolean {
    for (const [index, record] of known.entries()) {
      const incoming = rows[rows.length === 1 ? 0 : index];
      if (rows.length === known.length && incoming.text !== record.value.text) return false;
      const next = SessionMessages.replayMessage(record, { ...incoming, id: record.value.id, text: record.value.text,
        blockIndex: record.value.blockIndex }, stream);
      if (!next) return false;
      this.records.set(record.value.id, next);
      if (known.length === rows.length && incoming.id !== record.value.id && incoming.id.startsWith("native:")) {
        this.aliases.set(incoming.id, record.value.id);
      }
    }
    return true;
  }

  private splitJoined(known: StoredMessage, rows: Message[], stream: string): boolean {
    const first = known.value;
    const split = rows.map(row => SessionMessages.replayMessage({ ...known, value: { ...first,
      id: row.id, text: row.text, blockIndex: row.blockIndex } }, row, stream));
    if (split.some(item => !item)) return false;
    // Replace the joined slot in place so messages from independent streams keep their order.
    const ordered = [...this.records];
    this.records.clear();
    for (const [id, record] of ordered) {
      if (id !== first.id) this.records.set(id, record);
      else for (const item of split) if (item) this.records.set(item.value.id, item);
    }
    const parts = rows.map(row => row.id);
    for (const [key, proof] of this.proofs) {
      if (proof.ids.includes(first.id)) this.proofs.set(key, { ...proof, ids: proof.ids.flatMap(id => id === first.id ? parts : [id]) });
    }
    for (const [alias, id] of this.aliases) if (id === first.id) this.aliases.delete(alias);
    return true;
  }

  private accept(write: MessageWrite): boolean {
    const groups = SessionMessages.groupOccurrences(write);
    if (!groups) return false;
    const refinements = new Set(write.origins.filter(origin => origin.refinesAccepted).map(origin => origin.sourceOrder));
    for (const [key, rows] of groups) {
      const proof = typeof key === "string" && this.proofs.get(key);
      // A verified rewrite reserves old occurrence IDs. A later append can reproduce the same bytes.
      const ids = proof && (proof.stream !== write.stream || proof.generation === write.generation) && proof.ids;
      if (!ids && rows[0].sourceOrder !== undefined && refinements.has(rows[0].sourceOrder)) continue;
      if (ids && (ids.length !== rows.length || ids.some((id, i) => id !== rows[i].id))) {
        if (!this.reconcileBlocks(ids, rows, write.stream)) return false;
        continue;
      }
      for (const entry of rows) {
        const value = BatchValues.definedFields(entry);
        value.id = this.aliases.get(value.id) ?? value.id;
        if (value.context) value.context = BatchValues.definedFields(value.context);
        const existing = this.records.get(value.id);
        const next = existing ? SessionMessages.replayMessage(existing, value, write.stream) : { streamId: write.stream, value };
        if (!next) return false;
        this.records.set(value.id, next);
      }
      if (typeof key === "string") this.proofs.set(key, { ids: rows.map(row => this.aliases.get(row.id) ?? row.id),
        stream: write.stream, generation: write.generation });
    }
    if (write.rows.length) this.history = { write, prior: this.history };
    return true;
  }
}
