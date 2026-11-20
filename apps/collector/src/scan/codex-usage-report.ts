import type { CodexRolloutEntry } from "../history/index.ts";
import { isRecordedTimestamp } from "../recorded-timestamp.ts";
import type { TokenCounts, Usage } from "../storage/collector-storage.ts";
import { jsonDigest } from "./chat-parser-state.ts";
import { object, providerCounts } from "./codex-usage-counts.ts";

export type UsageEntry = Pick<CodexRolloutEntry, "sessionId" | "lineNumber" | "timestamp" | "record" | "sourceFile">
  & { afterBlankPrefix?: true };
export type Fields = Readonly<Record<string, unknown>>;
export type Call = Usage & { kind: "call" };
export type CallContext = Pick<Call, "turnId" | "requestId" | "model">;
export interface Report {
  at: string;
  sourceOrder: number;
  end?: TokenCounts;
  last?: Call;
  independent: boolean;
  invalidTotal: boolean;
}

function identifier(...values: unknown[]): string | undefined {
  return values.find((v): v is string => typeof v === "string" && v.length > 0);
}

export function recorded(value: unknown): value is string {
  return typeof value === "string" && isRecordedTimestamp(value);
}

function inherited(header: Fields): boolean {
  const links = ["forked_from_id", "forked_from", "forked_from_session_id", "parent_session_id", "parent_thread_id",
    "resume", "resume_from", "resumed_from", "resumed_from_id", "resumed_from_session_id", "resumed", "is_resume", "inherited"];
  const source = object(header.source);
  return links.some(key => Boolean(header[key])) || Boolean(source?.subagent || source?.resume || source?.fork)
    || (typeof header.source === "string" && /^(?:fork(?:ed)?|resume[d]?|subagent)$/i.test(header.source));
}

function fragmentOrdinal(ordinal: unknown): boolean {
  return ordinal !== undefined && ordinal !== null && ordinal !== 0;
}

function identifies(header: Fields, sessionId: string): boolean {
  const ids = [header.id, header.session_id].filter(id => typeof id === "string" && id.length);
  return ids.length > 0 && ids.every(id => id === sessionId);
}

export function initialHistory(entry: UsageEntry, payload: Fields | undefined): string {
  if ((entry.lineNumber === 1 || entry.afterBlankPrefix) && entry.record.type === "session_meta" && payload
    && identifies(payload, entry.sessionId) && !inherited(payload)
    && !fragmentOrdinal(entry.record.ordinal) && !fragmentOrdinal(payload.ordinal)) {
    const at = payload.timestamp ?? entry.timestamp ?? entry.record.timestamp;
    if (recorded(at)) return `verified:${jsonDigest([entry.sessionId, at])}`;
  }
  return `unverified:${jsonDigest([entry.sessionId, entry.sourceFile, entry.lineNumber, entry.timestamp])}`;
}

export function advanceContext(entry: UsageEntry, payload: Fields, previous: CallContext): CallContext {
  const turnId = identifier(payload.turn_id, entry.record.turn_id);
  const sameTurn = turnId !== undefined && turnId === previous.turnId;
  return {
    turnId, model: identifier(payload.model) ?? (sameTurn ? previous.model : undefined),
    requestId: identifier(payload.request_id, entry.record.request_id) ?? (sameTurn ? previous.requestId : undefined),
  };
}

function attribution(entry: UsageEntry, payload: Fields, info: Fields, context: CallContext) {
  const details = object(info.last_token_usage);
  const turnId = identifier(details?.turn_id, payload.turn_id, entry.record.turn_id) ?? context.turnId;
  const sameTurn = turnId === context.turnId;
  const callId = identifier(details?.call_id, info.call_id, payload.call_id, entry.record.call_id);
  const requestId = identifier(details?.request_id, info.request_id, payload.request_id, entry.record.request_id)
    ?? (sameTurn && !callId ? context.requestId : undefined);
  const native = requestId ? ["request", requestId] : callId ? ["call", callId] : undefined;
  const model = identifier(details?.model, payload.model, info.model) ?? (sameTurn ? context.model : undefined);
  return { native, fields: { ...(turnId && { turnId }), ...(model && { model }), ...(requestId && { requestId }) } };
}

const bookkeeping = new Set([
  "total_token_usage", "last_token_usage", "model_context_window", "model", "turn_id", "request_id", "call_id", "rate_limits",
]);
const misplacedUsageFields = ["usage", "total_token_usage", "last_token_usage", "input_tokens", "output_tokens", "total_tokens"];

function supplied(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function usageInfo(payload: Fields): Fields | null | undefined {
  const info = object(payload.info);
  if (info && (supplied(info.total_token_usage) || supplied(info.last_token_usage))) return info;
  if (supplied(payload.info) && (!info || !Object.keys(info).every(key => bookkeeping.has(key)))) return null;
  if (misplacedUsageFields.some(key => supplied(payload[key]))) return null;
}

/** Undefined is a bookkeeping update. Null is a usage report we cannot measure. */
export function readReport(entry: UsageEntry, payload: Fields, context: CallContext, historyId: string): Report | null | undefined {
  const info = usageInfo(payload);
  if (!info) return info;
  const end = providerCounts(info.total_token_usage);
  const amount = providerCounts(info.last_token_usage);
  if (!recorded(entry.timestamp) || (!end && !amount)) return null;
  const { native, fields } = attribution(entry, payload, info, context);
  const identity = native ? [entry.sessionId, ...native] : end && [historyId, end.inputTokens, end.outputTokens];
  const last: Call | undefined = amount && identity ? {
    kind: "call", revision: 1, at: entry.timestamp, ...amount, ...fields,
    id: (native ? "call:native:" : "call:") + jsonDigest(identity),
  } : undefined;
  const invalidTotal = supplied(info.total_token_usage) && !end;
  return { at: entry.timestamp, sourceOrder: entry.lineNumber, end, last, independent: Boolean(native), invalidTotal };
}
