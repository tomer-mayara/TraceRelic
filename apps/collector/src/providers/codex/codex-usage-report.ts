import type { CodexRolloutEntry } from "./codex-history.ts";
import { isRecordedTimestamp } from "@tracerelic/shared";
import type { TokenCounts, Usage } from "../../storage/collector-storage.ts";
import { type Fields, JsonRecord } from "../../transcript/json-record.ts";
import { ParserState } from "../../scan/parser-state.ts";
import { CodexTokenCounts } from "./codex-token-counts.ts";

export type UsageEntry = Pick<CodexRolloutEntry, "sessionId" | "lineNumber" | "timestamp" | "record" | "sourceFile">
  & { afterBlankPrefix?: true; startOffset?: number; endOffset?: number };
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

/** The turn, the request and the model that a Codex usage report gets from the earlier records. */
export class CodexCallContext {
  private static advance(entry: UsageEntry, payload: Fields, previous: CallContext): CallContext {
    const turnId = JsonRecord.identifier(payload.turn_id, entry.record.turn_id);
    const sameTurn = turnId !== undefined && turnId === previous.turnId;
    return {
      turnId, model: JsonRecord.identifier(payload.model) ?? (sameTurn ? previous.model : undefined),
      requestId: JsonRecord.identifier(payload.request_id, entry.record.request_id) ?? (sameTurn ? previous.requestId : undefined),
    };
  }

  /** Keep attribution scoped to the native turn. A thread-labelled item can establish a fork's active turn. */
  static after(entry: UsageEntry, payload: Fields, previous: CallContext, includeItems = false): CallContext {
    if (entry.record.type === "turn_context") return CodexCallContext.advance(entry, payload, previous);
    if (entry.record.type !== "event_msg") return previous;
    switch (payload.type) {
      case "task_started":
      case "turn_started":
        return CodexCallContext.advance(entry, payload, previous);
      case "item_started":
      case "item_completed":
        if (includeItems && typeof payload.thread_id === "string" && typeof payload.turn_id === "string") {
          return CodexCallContext.advance(entry, payload, previous);
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
}

const bookkeeping = new Set([
  "total_token_usage", "last_token_usage", "model_context_window", "model", "turn_id", "request_id", "call_id", "rate_limits",
]);
const misplacedUsageFields = ["usage", "total_token_usage", "last_token_usage", "input_tokens", "output_tokens", "total_tokens"];

/** The token usage reports of a Codex rollout. The class also gives the history ID at the start of the rollout. */
export class CodexUsageReport {
  static recorded(value: unknown): value is string {
    return typeof value === "string" && isRecordedTimestamp(value);
  }

  private static inherited(header: Fields): boolean {
    const links = ["forked_from_id", "forked_from", "forked_from_session_id", "parent_session_id", "parent_thread_id",
      "resume", "resume_from", "resumed_from", "resumed_from_id", "resumed_from_session_id", "resumed", "is_resume", "inherited"];
    const source = JsonRecord.object(header.source);
    return links.some(key => Boolean(header[key])) || Boolean(source?.subagent || source?.resume || source?.fork)
      || (typeof header.source === "string" && /^(?:fork(?:ed)?|resume[d]?|subagent)$/i.test(header.source));
  }

  private static fragmentOrdinal(ordinal: unknown): boolean {
    return ordinal !== undefined && ordinal !== null && ordinal !== 0;
  }

  private static identifies(header: Fields, sessionId: string): boolean {
    const ids = [header.id, header.session_id].filter(id => typeof id === "string" && id.length);
    return ids.length > 0 && ids.every(id => id === sessionId);
  }

  static initialHistory(entry: UsageEntry, payload: Fields | undefined): string {
    if ((entry.lineNumber === 1 || entry.afterBlankPrefix) && entry.record.type === "session_meta" && payload
      && CodexUsageReport.identifies(payload, entry.sessionId) && !CodexUsageReport.inherited(payload)
      && !CodexUsageReport.fragmentOrdinal(entry.record.ordinal) && !CodexUsageReport.fragmentOrdinal(payload.ordinal)) {
      const at = payload.timestamp ?? entry.timestamp ?? entry.record.timestamp;
      if (CodexUsageReport.recorded(at)) return `verified:${ParserState.digest([entry.sessionId, at])}`;
    }
    return `unverified:${ParserState.digest([entry.sessionId, entry.sourceFile, entry.lineNumber, entry.timestamp])}`;
  }

  private static attribution(entry: UsageEntry, payload: Fields, info: Fields, context: CallContext) {
    const details = JsonRecord.object(info.last_token_usage);
    const turnId = JsonRecord.identifier(details?.turn_id, payload.turn_id, entry.record.turn_id) ?? context.turnId;
    const sameTurn = turnId === context.turnId;
    const callId = JsonRecord.identifier(details?.call_id, info.call_id, payload.call_id, entry.record.call_id);
    const requestId = JsonRecord.identifier(details?.request_id, info.request_id, payload.request_id, entry.record.request_id)
      ?? (sameTurn && !callId ? context.requestId : undefined);
    const native = callId ? ["call", callId] : requestId ? ["request", requestId] : undefined;
    const model = JsonRecord.identifier(details?.model, payload.model, info.model) ?? (sameTurn ? context.model : undefined);
    const alias = callId && requestId ? CodexUsageReport.nativeCallId(entry.sessionId, ["request", requestId]) : undefined;
    return { native, alias, fields: { ...(turnId && { turnId }), ...(model && { model }), ...(requestId && { requestId }) } };
  }

  private static nativeCallId(sessionId: string, native: string[]): string {
    return "call:native:" + ParserState.digest([sessionId, ...native]);
  }

  private static closingCallId(historyId: string, end: TokenCounts): string {
    return "call:" + ParserState.digest([historyId, end.inputTokens, end.outputTokens]);
  }

  private static supplied(value: unknown): boolean {
    return value !== undefined && value !== null;
  }

  private static usageInfo(payload: Fields): Fields | null | undefined {
    const info = JsonRecord.object(payload.info);
    if (info && (CodexUsageReport.supplied(info.total_token_usage) || CodexUsageReport.supplied(info.last_token_usage))) return info;
    if (CodexUsageReport.supplied(payload.info) && (!info || !Object.keys(info).every(key => bookkeeping.has(key)))) return null;
    if (misplacedUsageFields.some(key => CodexUsageReport.supplied(payload[key]))) return null;
  }

  private static responseUsage(entry: UsageEntry, payload: Fields, context: CallContext, historyId: string): Report | null {
    const amount = CodexTokenCounts.fromProvider(payload.usage), end = CodexTokenCounts.fromProvider(payload.thread_token_usage);
    const ownerThread = JsonRecord.identifier(payload.thread_id), responseId = JsonRecord.identifier(payload.response_id);
    if (!ownerThread || !responseId || !CodexUsageReport.recorded(entry.timestamp) || !amount) return null;
    const native = ["response", responseId], turnId = JsonRecord.identifier(payload.turn_id);
    const last: Call = { id: CodexUsageReport.nativeCallId(ownerThread, native), kind: "call", revision: 1, at: entry.timestamp, ...amount,
      responseId, ...(turnId && { turnId }), ...(turnId === context.turnId && context.model && { model: context.model }) };
    return { at: entry.timestamp, sourceOrder: entry.lineNumber, independent: true, providerId: ParserState.digest(native),
      end, last, ownerThread, turnId, invalidTotal: CodexUsageReport.supplied(payload.thread_token_usage) && !end,
      ...(historyId.startsWith("verified:") && end && (amount.inputTokens || amount.outputTokens) && { aliases: [CodexUsageReport.closingCallId(historyId, end)] }) };
  }

  /** Undefined is a bookkeeping update. Null is a usage report we cannot measure. */
  static read(entry: UsageEntry, payload: Fields, context: CallContext, historyId: string): Report | null | undefined {
    if (entry.record.type === "token_usage_record") return CodexUsageReport.responseUsage(entry, payload, context, historyId);
    const info = CodexUsageReport.usageInfo(payload);
    if (!info) return info;
    const end = CodexTokenCounts.fromProvider(info.total_token_usage);
    const amount = CodexTokenCounts.fromProvider(info.last_token_usage);
    if (!CodexUsageReport.recorded(entry.timestamp) || (!end && !amount)) return null;
    const { native, alias, fields } = CodexUsageReport.attribution(entry, payload, info, context);
    const id = native ? CodexUsageReport.nativeCallId(entry.sessionId, native) : end && CodexUsageReport.closingCallId(historyId, end);
    const last: Call | undefined = amount && id ? {
      kind: "call", revision: 1, at: entry.timestamp, ...amount, ...fields,
      id,
    } : undefined;
    const invalidTotal = CodexUsageReport.supplied(info.total_token_usage) && !end;
    const aliases = alias ? [alias] : [];
    if (native && historyId.startsWith("verified:") && end && amount && (amount.inputTokens || amount.outputTokens)) aliases.push(CodexUsageReport.closingCallId(historyId, end));
    return { at: entry.timestamp, sourceOrder: entry.lineNumber, end, last, independent: Boolean(native),
      providerId: native && ParserState.digest(native), turnId: fields.turnId, invalidTotal, ...(aliases.length && { aliases }) };
  }
}
