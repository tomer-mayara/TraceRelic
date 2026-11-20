import { isDeepStrictEqual } from "node:util";
import { isRecordedTimestamp } from "../recorded-timestamp.ts";
import type {
  Batch, BranchObservation, Checkpoint, CheckpointSnapshot, CollectorStorage, CommitResult, Coverage,
  Message, Metadata, SessionKey, SessionView, StreamKey, Usage,
} from "./collector-storage.ts";

function encodeSessionKey(key: SessionKey): string {
  return JSON.stringify([key.harness, key.sessionId]);
}

function encodeStreamKey(source: StreamKey): string {
  const parts = [source.harness, source.sessionId, source.streamId];
  if (source.installationId !== undefined) parts.push(source.installationId);
  return JSON.stringify(parts);
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isRecordNumber(value: number): boolean {
  return isCount(value) && value > 0;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasValidMetadata(fields: Metadata | undefined): boolean {
  if (fields === undefined) return true;
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return false;
  return [fields.cwd, fields.branch, fields.repository].every(value => value === undefined || typeof value === "string")
    && (fields.parentSessionId === undefined || isIdentifier(fields.parentSessionId));
}

function hasValidCounts(usage: Usage): boolean {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const reasoning = usage.reasoningTokens ?? 0;
  return [usage.revision, usage.inputTokens, usage.outputTokens, cacheRead, cacheWrite, reasoning].every(isCount)
    && usage.revision > 0
    && cacheRead + cacheWrite <= usage.inputTokens
    && reasoning <= usage.outputTokens;
}

function hasValidIdentity(record: Message | Usage): boolean {
  return isIdentifier(record.id) && isRecordedTimestamp(record.at);
}

function hasValidMessage(message: Message): boolean {
  return hasValidIdentity(message) && (message.role === "user" || message.role === "assistant")
    && typeof message.text === "string"
    && (message.sourceOrder === undefined || isRecordNumber(message.sourceOrder))
    && (message.blockIndex === undefined || isCount(message.blockIndex))
    && (message.turnId === undefined || isIdentifier(message.turnId))
    && (message.requestId === undefined || isIdentifier(message.requestId))
    && hasValidMetadata(message.context);
}

function definedFields<T extends object>(fields: T): T {
  const copy = { ...fields };
  for (const key in copy) {
    if (copy[key] === undefined) delete copy[key];
  }
  return copy;
}

interface StoredMessage {
  streamId: string;
  value: Message;
}

function conflictingFields<T extends object>(known: T, incoming: T): boolean {
  for (const key in incoming) {
    if (known[key] !== undefined && incoming[key] !== undefined && known[key] !== incoming[key]) return true;
  }
  return false;
}

function replayMessage(known: StoredMessage, incoming: Message, streamId: string): StoredMessage | null {
  const { sourceOrder, blockIndex, context, ...fields } = incoming;
  const previous = known.value;
  if (conflictingFields(previous, fields) || conflictingFields(previous.context ?? {}, context ?? {})) return null;
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

function mergeMessages(
  previous: Map<string, StoredMessage> | undefined, incoming: Message[], streamId: string,
): Map<string, StoredMessage> | null {
  const messages = new Map(previous);
  for (const entry of incoming) {
    if (!hasValidMessage(entry)) return null;
    const value = definedFields(entry);
    if (value.context) value.context = definedFields(value.context);
    const existing = messages.get(value.id);
    const next = existing ? replayMessage(existing, value, streamId) : { streamId, value };
    if (!next) return null;
    messages.set(value.id, next);
  }
  return messages;
}

function orderedMessages(records: Map<string, StoredMessage>): Message[] {
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

function mergeUsage(previous: Usage[], incoming: Usage[]): Usage[] | null {
  const records = new Map(previous.map((usage) => [usage.id, usage]));
  for (const entry of incoming) {
    const usage = definedFields(entry);
    if (!hasValidIdentity(usage) || !hasValidCounts(usage)) return null;
    const existing = records.get(usage.id);
    if (existing?.revision === usage.revision && !isDeepStrictEqual(existing, usage)) return null;
    if (!existing || usage.revision > existing.revision) records.set(usage.id, usage);
  }
  return [...records.values()];
}

interface RecordedBranch {
  streamId: string;
  name: string;
  sourceOrder: number;
  instant?: { second: number; fraction: string };
}

interface BranchHistory {
  byStream: Map<string, RecordedBranch>;
  latest: RecordedBranch;
}

function recordedBranch(streamId: string, name: string, observation: BranchObservation): RecordedBranch | null {
  const { at, sourceOrder } = observation;
  if (!isRecordNumber(sourceOrder)) return null;
  const branch = { streamId, name, sourceOrder };
  if (at === undefined) return branch;
  if (!isRecordedTimestamp(at)) return null;
  const seconds = at.slice(17, 19);
  const tail = at.slice(19);
  const zoneStart = tail.search(/[z+-]/i);
  const zone = tail.slice(zoneStart);
  const offset = zone.length === 3 ? `${zone}:00` : zone;
  const second = Date.parse(`${at.slice(0, 10)}T${at.slice(11, 17)}${seconds === "60" ? "59" : seconds}${offset}`);
  if (!Number.isFinite(second)) return null;
  // Keep every fractional digit. A leap second follows every fraction of second 59.
  const fraction = (seconds === "60" ? "1" : "0") + tail.slice(1, zoneStart).replace(/0+$/, "");
  return { ...branch, instant: { second, fraction } };
}

function mergeBranches(
  previous: BranchHistory | undefined, batch: Batch, streamId: string,
): BranchHistory | null | undefined {
  const observation = batch.branchObservation;
  if (observation === undefined) return previous;
  if (!observation || !batch.metadata?.branch) return null;
  const candidate = recordedBranch(streamId, batch.metadata.branch, observation);
  if (!candidate) return null;
  const known = previous?.byStream.get(streamId);
  if (known && known.sourceOrder >= candidate.sourceOrder) return previous;
  const byStream = new Map(previous?.byStream);
  byStream.set(streamId, candidate);
  let latest = previous && previous.latest.streamId !== streamId ? previous.latest : candidate;
  for (const branch of byStream.values()) {
    const time = branch.instant;
    const current = latest.instant;
    if (!time || !current) continue;
    if (time.second > current.second || (time.second === current.second && time.fraction > current.fraction)) {
      latest = branch;
    }
  }
  return { byStream, latest };
}

interface StoredSession {
  version: number;
  checkpoints: Map<string, Checkpoint>;
  view: Omit<SessionView, "messages">;
  messages: Map<string, StoredMessage>;
  branches?: BranchHistory;
  hasGap: boolean;
}

function coverage(records: number, hasGap: boolean): Coverage {
  if (records === 0) return "unknown";
  return hasGap ? "partial" : "reported";
}

function mergeSessionRecords(
  previous: StoredSession | undefined, batch: Batch, stream: string,
): Omit<StoredSession, "version" | "checkpoints"> | null {
  if (!hasValidMetadata(batch.metadata)) return null;
  const messages = mergeMessages(previous?.messages, batch.messages, stream);
  const usage = mergeUsage(previous?.view.usage ?? [], batch.usage);
  const branches = mergeBranches(previous?.branches, batch, stream);
  if (!messages || !usage || branches === null) return null;
  const total = usage.reduce((sum, record) => sum + record.inputTokens + record.outputTokens, 0);
  if (!isCount(total)) return null;
  const hasGap = previous?.hasGap === true || batch.hasGap === true;
  const metadata = { ...previous?.view.metadata, ...definedFields(batch.metadata ?? {}) };
  if (branches) metadata.branch = branches.latest.name;
  const view = {
    key: { harness: batch.source.harness, sessionId: batch.source.sessionId }, metadata, usage,
    coverage: coverage(usage.length, hasGap), observedTotalTokens: usage.length ? total : null,
  };
  return { view, messages, branches, hasGap };
}

export class InMemoryCollectorStorage implements CollectorStorage {
  private readonly sessions = new Map<string, StoredSession>();

  async readCheckpoint(source: StreamKey): Promise<CheckpointSnapshot> {
    const session = this.sessions.get(encodeSessionKey(source));
    const checkpoint = session?.checkpoints.get(encodeStreamKey(source)) ?? null;
    return { version: session?.version ?? 0, checkpoint: structuredClone(checkpoint) };
  }

  async readSession(key: SessionKey): Promise<SessionView | null> {
    const stored = this.sessions.get(encodeSessionKey(key));
    return stored ? structuredClone({ ...stored.view, messages: orderedMessages(stored.messages) }) : null;
  }

  async commit(batch: Batch): Promise<CommitResult> {
    const { source, checkpoint, expectedVersion, expectedOffset } = batch;
    if (!isIdentifier(source.sessionId) || !isIdentifier(source.streamId)
      || (source.installationId !== undefined && !isIdentifier(source.installationId))) return "invalid";
    if (!isCount(expectedVersion) || !isCount(expectedOffset)) return "invalid";
    const session = encodeSessionKey(source);
    const stream = encodeStreamKey(source);
    // Compare both values and publish the complete session in one synchronous turn.
    const previous = this.sessions.get(session);
    const currentVersion = previous?.version ?? 0;
    const currentOffset = previous?.checkpoints.get(stream)?.offset ?? 0;
    if (expectedVersion !== currentVersion || expectedOffset !== currentOffset) return "conflict";
    const version = currentVersion + 1;
    if (!isCount(version) || !isCount(checkpoint.offset) || checkpoint.offset <= currentOffset
      || typeof checkpoint.parserState !== "string") return "invalid";
    const records = mergeSessionRecords(previous, batch, stream);
    if (!records) return "invalid";
    const checkpoints = new Map(previous?.checkpoints);
    checkpoints.set(stream, structuredClone(checkpoint));
    this.sessions.set(session, { version, checkpoints, ...structuredClone(records) });
    return "committed";
  }
}
