import { isDeepStrictEqual } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import type {
  Batch, Checkpoint, CollectorStorage, CommitResult, Coverage, Message, SessionKey, SessionView, StreamKey, Usage,
} from "../storage/collector-storage.js";

function encodeSessionKey(key: SessionKey): string {
  return JSON.stringify([key.harness, key.sessionId]);
}

function encodeStreamKey(source: StreamKey): string {
  return JSON.stringify([source.harness, source.sessionId, source.streamId]);
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
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

const validTimestamp = new Ajv2020({ formats: fullFormats }).compile({ type: "string", format: "date-time" });

function hasValidIdentity(record: Message | Usage): boolean {
  return record.id.length > 0 && validTimestamp(record.at);
}

function definedFields<T extends object>(fields: T): T {
  const copy = { ...fields };
  for (const key in copy) {
    if (copy[key] === undefined) delete copy[key];
  }
  return copy;
}

function mergeMessages(previous: Message[], incoming: Message[]): Message[] | null {
  const messages = new Map(previous.map((message) => [message.id, message]));
  for (const message of incoming) {
    const existing = messages.get(message.id);
    if (!hasValidIdentity(message) || (existing && !isDeepStrictEqual(existing, message))) return null;
    messages.set(message.id, message);
  }
  return [...messages.values()];
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

interface StoredSession {
  view: SessionView;
  hasGap: boolean;
}

function coverage(records: number, hasGap: boolean): Coverage {
  if (records === 0) return "unknown";
  return hasGap ? "partial" : "reported";
}

export class InMemoryCollectorStorage implements CollectorStorage {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly checkpoints = new Map<string, Checkpoint>();

  async readCheckpoint(source: StreamKey): Promise<Checkpoint | null> {
    return structuredClone(this.checkpoints.get(encodeStreamKey(source)) ?? null);
  }

  async readSession(key: SessionKey): Promise<SessionView | null> {
    return structuredClone(this.sessions.get(encodeSessionKey(key))?.view ?? null);
  }

  async commit(batch: Batch): Promise<CommitResult> {
    const { source, checkpoint } = batch;
    const stream = encodeStreamKey(source);
    if (!source.sessionId || !source.streamId || !isCount(batch.expectedOffset)) return "invalid";
    // Keep the comparison and both writes in one synchronous turn.
    if (batch.expectedOffset !== (this.checkpoints.get(stream)?.offset ?? 0)) return "conflict";
    if (!isCount(checkpoint.offset) || checkpoint.offset <= batch.expectedOffset) return "invalid";
    if (batch.metadata?.parentSessionId === "") return "invalid";
    const session = encodeSessionKey(source);
    const previous = this.sessions.get(session);
    const messages = mergeMessages(previous?.view.messages ?? [], batch.messages);
    const usage = mergeUsage(previous?.view.usage ?? [], batch.usage);
    if (!messages || !usage) return "invalid";
    const total = usage.reduce((sum, record) => sum + record.inputTokens + record.outputTokens, 0);
    if (!isCount(total)) return "invalid";
    const hasGap = previous?.hasGap === true || batch.hasGap === true;
    const view: SessionView = {
      key: { harness: source.harness, sessionId: source.sessionId },
      metadata: { ...previous?.view.metadata, ...definedFields(batch.metadata ?? {}) },
      messages,
      usage,
      coverage: coverage(usage.length, hasGap),
      observedTotalTokens: usage.length ? total : null,
    };
    const nextCheckpoint = structuredClone(checkpoint);
    this.sessions.set(session, structuredClone({ view, hasGap }));
    this.checkpoints.set(stream, nextCheckpoint);
    return "committed";
  }
}
