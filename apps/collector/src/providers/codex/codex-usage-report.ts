import type { CodexRolloutEntry } from "../index.ts";
import { isRecordedTimestamp } from "@tracerelic/shared";
import type { TokenCounts, Usage } from "../../storage/collector-storage.ts";
import { JsonRecord } from "../../transcript/json-record.ts";
import { ParserState } from "../../scan/parser-state.ts";
import { providerCounts } from "./codex-token-counts.ts";

export type UsageEntry = Pick<CodexRolloutEntry, "sessionId" | "lineNumber" | "timestamp" | "record" | "sourceFile">
  & { afterBlankPrefix?: true; startOffset?: number; endOffset?: number };
export type Fields = Readonly<Record<string, unknown>>;
export type Call = Usage & { kind: "call" };
export type CallContext = Pick<Call, "turnId" | "requestId" | "model">;
export interface Report {
  at: string;
  sourceOrder: number;
  end?: TokenCounts;
  last?: Call;
  independent: boolean;
  providerId?: string;
  turnId?: string;
  invalidTotal: boolean;
  aliases?: string[];
  ownerThread?: string;
}

export function recorded(value: unknown): value is string {
  return typeof value === "string" && isRecordedTimestamp(value);
}

function inherited(header: Fields): boolean {
  const links = ["forked_from_id", "forked_from", "forked_from_session_id", "parent_session_id", "parent_thread_id",
    "resume", "resume_from", "resumed_from", "resumed_from_id", "resumed_from_session_id", "resumed", "is_resume", "inherited"];
  const source = JsonRecord.object(header.source);
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
    if (recorded(at)) return `verified:${ParserState.digest([entry.sessionId, at])}`;
  }
  return `unverified:${ParserState.digest([entry.sessionId, entry.sourceFile, entry.lineNumber, entry.timestamp])}`;
}

function advanceContext(entry: UsageEntry, payload: Fields, previous: CallContext): CallContext {
  const turnId = JsonRecord.identifier(payload.turn_id, entry.record.turn_id);
  const sameTurn = turnId !== undefined && turnId === previous.turnId;
  return {
    turnId, model: JsonRecord.identifier(payload.model) ?? (sameTurn ? previous.model : undefined),
    requestId: JsonRecord.identifier(payload.request_id, entry.record.request_id) ?? (sameTurn ? previous.requestId : undefined),
  };
}

/** Keep attribution scoped to the native turn. A thread-labelled item can establish a fork's active turn. */
export function reportContext(entry: UsageEntry, payload: Fields, previous: CallContext, includeItems = false): CallContext {
  if (entry.record.type === "turn_context") return advanceContext(entry, payload, previous);
  if (entry.record.type !== "event_msg") return previous;
  switch (payload.type) {
    case "task_started":
    case "turn_started":
      return advanceContext(entry, payload, previous);
    case "item_started":
    case "item_completed":
      if (includeItems && typeof payload.thread_id === "string" && typeof payload.turn_id === "string") {
        return advanceContext(entry, payload, previous);
      }
      return previous;
    case "task_complete":
    case "turn_complete":
    case "turn_aborted":
      return {};
    default:
      return previous;
  }
}

function attribution(entry: UsageEntry, payload: Fields, info: Fields, context: CallContext) {
  const details = JsonRecord.object(info.last_token_usage);
  const turnId = JsonRecord.identifier(details?.turn_id, payload.turn_id, entry.record.turn_id) ?? context.turnId;
  const sameTurn = turnId === context.turnId;
  const callId = JsonRecord.identifier(details?.call_id, info.call_id, payload.call_id, entry.record.call_id);
  const requestId = JsonRecord.identifier(details?.request_id, info.request_id, payload.request_id, entry.record.request_id)
    ?? (sameTurn && !callId ? context.requestId : undefined);
  const native = callId ? ["call", callId] : requestId ? ["request", requestId] : undefined;
  const model = JsonRecord.identifier(details?.model, payload.model, info.model) ?? (sameTurn ? context.model : undefined);
  const alias = callId && requestId ? nativeCallId(entry.sessionId, ["request", requestId]) : undefined;
  return { native, alias, fields: { ...(turnId && { turnId }), ...(model && { model }), ...(requestId && { requestId }) } };
}

function nativeCallId(sessionId: string, native: string[]): string {
  return "call:native:" + ParserState.digest([sessionId, ...native]);
}

function closingCallId(historyId: string, end: TokenCounts): string {
  return "call:" + ParserState.digest([historyId, end.inputTokens, end.outputTokens]);
}

const bookkeeping = new Set([
  "total_token_usage", "last_token_usage", "model_context_window", "model", "turn_id", "request_id", "call_id", "rate_limits",
]);
const misplacedUsageFields = ["usage", "total_token_usage", "last_token_usage", "input_tokens", "output_tokens", "total_tokens"];

function supplied(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function usageInfo(payload: Fields): Fields | null | undefined {
  const info = JsonRecord.object(payload.info);
  if (info && (supplied(info.total_token_usage) || supplied(info.last_token_usage))) return info;
  if (supplied(payload.info) && (!info || !Object.keys(info).every(key => bookkeeping.has(key)))) return null;
  if (misplacedUsageFields.some(key => supplied(payload[key]))) return null;
}

function responseUsage(entry: UsageEntry, payload: Fields, context: CallContext, historyId: string): Report | null {
  const amount = providerCounts(payload.usage), end = providerCounts(payload.thread_token_usage);
  const ownerThread = JsonRecord.identifier(payload.thread_id), responseId = JsonRecord.identifier(payload.response_id);
  if (!ownerThread || !responseId || !recorded(entry.timestamp) || !amount) return null;
  const native = ["response", responseId], turnId = JsonRecord.identifier(payload.turn_id);
  const last: Call = { id: nativeCallId(ownerThread, native), kind: "call", revision: 1, at: entry.timestamp, ...amount,
    responseId, ...(turnId && { turnId }), ...(turnId === context.turnId && context.model && { model: context.model }) };
  return { at: entry.timestamp, sourceOrder: entry.lineNumber, independent: true, providerId: ParserState.digest(native),
    end, last, ownerThread, turnId, invalidTotal: supplied(payload.thread_token_usage) && !end,
    ...(historyId.startsWith("verified:") && end && (amount.inputTokens || amount.outputTokens) && { aliases: [closingCallId(historyId, end)] }) };
}

/** Undefined is a bookkeeping update. Null is a usage report we cannot measure. */
export function readReport(entry: UsageEntry, payload: Fields, context: CallContext, historyId: string): Report | null | undefined {
  if (entry.record.type === "token_usage_record") return responseUsage(entry, payload, context, historyId);
  const info = usageInfo(payload);
  if (!info) return info;
  const end = providerCounts(info.total_token_usage);
  const amount = providerCounts(info.last_token_usage);
  if (!recorded(entry.timestamp) || (!end && !amount)) return null;
  const { native, alias, fields } = attribution(entry, payload, info, context);
  const id = native ? nativeCallId(entry.sessionId, native) : end && closingCallId(historyId, end);
  const last: Call | undefined = amount && id ? {
    kind: "call", revision: 1, at: entry.timestamp, ...amount, ...fields,
    id,
  } : undefined;
  const invalidTotal = supplied(info.total_token_usage) && !end;
  const aliases = alias ? [alias] : [];
  if (native && historyId.startsWith("verified:") && end && amount && (amount.inputTokens || amount.outputTokens)) aliases.push(closingCallId(historyId, end));
  return { at: entry.timestamp, sourceOrder: entry.lineNumber, end, last, independent: Boolean(native),
    providerId: native && ParserState.digest(native), turnId: fields.turnId, invalidTotal, ...(aliases.length && { aliases }) };
}
