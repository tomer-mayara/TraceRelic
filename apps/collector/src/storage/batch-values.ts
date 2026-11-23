import { isRecordedTimestamp } from "@tracerelic/shared";
import type { ByteRange, ClaudeCallOrigin, ClaudeUsageReport, TokenCounts, Usage, UsageStatus } from "./collector-storage.ts";

/** The rules that storage applies to the values of a batch. */
export class BatchValues {
  static definedFields<T extends object>(fields: T): T {
    const copy = { ...fields };
    for (const key in copy) {
      if (copy[key] === undefined) delete copy[key];
    }
    return copy;
  }

  static isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  }

  static isIdentifier(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
  }

  static isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  static isByteRange(value: unknown, acceptedEnd = Number.MAX_SAFE_INTEGER): value is ByteRange {
    return BatchValues.isRecord(value) && BatchValues.isCount(value.startOffset) && BatchValues.isCount(value.endOffset)
      && value.startOffset < value.endOffset && value.endOffset <= acceptedEnd;
  }

  static isTokenCounts(value: unknown): value is TokenCounts {
    if (!BatchValues.isRecord(value)) return false;
    const { inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0, reasoningTokens = 0 } = value;
    return BatchValues.isCount(inputTokens) && BatchValues.isCount(outputTokens)
      && BatchValues.isCount(cacheReadTokens) && BatchValues.isCount(cacheWriteTokens) && BatchValues.isCount(reasoningTokens)
      && cacheReadTokens + cacheWriteTokens <= inputTokens && reasoningTokens <= outputTokens;
  }

  private static isUsageStatus(value: unknown): value is UsageStatus {
    return value === "provisional" || value === "final";
  }

  private static hasValidDurations(value: Record<string, unknown>): boolean {
    const has5m = value.cacheWrite5mTokens !== undefined;
    const has1h = value.cacheWrite1hTokens !== undefined;
    if (!has5m && !has1h) return true;
    const { cacheWrite5mTokens = 0, cacheWrite1hTokens = 0, cacheWriteTokens } = value;
    if (!BatchValues.isCount(cacheWriteTokens) || !BatchValues.isCount(cacheWrite5mTokens) || !BatchValues.isCount(cacheWrite1hTokens)) return false;
    const sum = cacheWrite5mTokens + cacheWrite1hTokens;
    return has5m && has1h ? sum === cacheWriteTokens : sum <= cacheWriteTokens;
  }

  private static hasValidCallFields(value: Record<string, unknown>): boolean {
    return [value.messageId, value.requestId, value.iterationId, value.turnId].every(field => field === undefined || BatchValues.isIdentifier(field))
      && (value.model === undefined || typeof value.model === "string")
      && (value.status === undefined || BatchValues.isUsageStatus(value.status))
      && (value.iterationId === undefined || BatchValues.isIdentifier(value.messageId) || BatchValues.isIdentifier(value.requestId));
  }

  private static isClaudeOrigin(value: unknown): value is ClaudeCallOrigin {
    if (!BatchValues.isRecord(value)) return false;
    if (value.parentMessageUuid !== undefined && (value.kind !== "copy" || !BatchValues.isIdentifier(value.parentSessionId))) return false;
    if (value.kind === "subagent" && !BatchValues.isIdentifier(value.parentSessionId)) return false;
    return (value.kind === "own" || value.kind === "copy" || value.kind === "subagent")
      && BatchValues.isCount(value.sourceOrder) && value.sourceOrder > 0 && BatchValues.isByteRange(value.byteRange)
      && [value.transcriptUuid, value.parentSessionId, value.parentMessageUuid].every(id => id === undefined || BatchValues.isIdentifier(id));
  }

  static isClaudeUsageReport(value: unknown): value is ClaudeUsageReport {
    return BatchValues.isRecord(value) && BatchValues.isTokenCounts(value) && BatchValues.isCount(value.inputTokens + value.outputTokens)
      && BatchValues.isUsageStatus(value.status) && isRecordedTimestamp(value.at)
      && (BatchValues.isIdentifier(value.messageId) || BatchValues.isIdentifier(value.requestId))
      && BatchValues.hasValidCallFields(value) && BatchValues.hasValidDurations(value) && (value.origin === undefined || BatchValues.isClaudeOrigin(value.origin))
      && (value.iterationPosition === undefined || (BatchValues.isCount(value.iterationPosition) && BatchValues.isIdentifier(value.iterationId)
        && (!value.iterationId.startsWith("index:") || value.iterationId === `index:${value.iterationPosition}`)));
  }

  static isUsage(value: unknown): value is Usage {
    if (!BatchValues.isRecord(value)) return false;
    const { id, revision, at, kind, model } = value;
    if (!BatchValues.isIdentifier(id) || !BatchValues.isCount(revision) || revision < 1 || !isRecordedTimestamp(at) || !BatchValues.isTokenCounts(value)) return false;
    if (kind === "call") return BatchValues.hasValidCallFields(value) && BatchValues.hasValidDurations(value)
      && (value.responseId === undefined || BatchValues.isIdentifier(value.responseId));
    const callFields = ["status", "messageId", "requestId", "responseId", "turnId", "iterationId", "cacheWrite5mTokens", "cacheWrite1hTokens"];
    return callFields.every(field => value[field] === undefined)
      && ((kind === undefined && (model === undefined || typeof model === "string")) || (kind === "interval" && model === undefined));
  }

  static isNativeCodexCall(usage: Usage): boolean {
    return usage.kind === "call" && (BatchValues.isIdentifier(usage.requestId) || BatchValues.isIdentifier(usage.responseId) || /^call:native:[a-f0-9]{64}$/.test(usage.id));
  }

  /** Copies can report a native call at different times. Retain its first accepted observation. */
  static mergeCodexCall(known: Usage, incoming: Usage): Usage | null {
    if (known.kind !== "call" || incoming.kind !== "call" || known.id !== incoming.id
      || known.revision !== incoming.revision || known.inputTokens !== incoming.inputTokens
      || known.outputTokens !== incoming.outputTokens) return null;
    if (known.at !== incoming.at && !(BatchValues.isNativeCodexCall(known) && BatchValues.isNativeCodexCall(incoming)) && !known.responseId && !incoming.responseId) return null;
    const merged = { ...known };
    for (const field of ["model", "turnId", "requestId", "responseId", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
      const earlier = known[field];
      const later = incoming[field];
      if (later === undefined) continue;
      if (earlier !== undefined && earlier !== later) return null;
      Object.assign(merged, { [field]: later });
    }
    return BatchValues.isTokenCounts(merged) ? merged : null;
  }
}
