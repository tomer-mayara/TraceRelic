import { isDeepStrictEqual } from "node:util";
import type { Message, SessionView, Usage } from "@tracerelic/collector/storage";

export type SessionRecords = Pick<SessionView, "messages" | "usage">;
export interface RecordChanges<T> {
  upserts: { ordinal: number; record: T }[];
  removed: string[];
}
export interface PersistedSession {
  version: number;
  summary: Omit<SessionView, "messages" | "usage">;
  messages: RecordChanges<Message>;
  usage: RecordChanges<Usage>;
}

function changes<T extends { id: string }>(before: readonly T[], after: readonly T[]): RecordChanges<T> {
  const remaining = new Map(before.map((record, index) => [record.id, { record, index }]));
  const upserts: RecordChanges<T>["upserts"] = [];
  for (const [index, record] of after.entries()) {
    const prior = remaining.get(record.id);
    remaining.delete(record.id);
    if (prior?.index !== index || !isDeepStrictEqual(prior.record, record)) upserts.push({ ordinal: index + 1, record });
  }
  return { upserts, removed: [...remaining.keys()] };
}

/** Ordinary presence changes only the summary. An existing database supplies the actual previously projected records. */
export function projectSession(version: number, view: SessionView, before?: SessionRecords): PersistedSession {
  const { messages, usage, ...summary } = view;
  return { version, summary, messages: before ? changes(before.messages, messages) : { upserts: [], removed: [] },
    usage: before ? changes(before.usage, usage) : { upserts: [], removed: [] } };
}
