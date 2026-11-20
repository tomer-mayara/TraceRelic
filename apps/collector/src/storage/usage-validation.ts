import { isRecordedTimestamp } from "../recorded-timestamp.ts";
import type { ClaudeUsageReport, TokenCounts, Usage, UsageStatus } from "./collector-storage.ts";

export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isTokenCounts(value: unknown): value is TokenCounts {
  if (!isRecord(value)) return false;
  const { inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0, reasoningTokens = 0 } = value;
  return isCount(inputTokens) && isCount(outputTokens)
    && isCount(cacheReadTokens) && isCount(cacheWriteTokens) && isCount(reasoningTokens)
    && cacheReadTokens + cacheWriteTokens <= inputTokens && reasoningTokens <= outputTokens;
}

function isUsageStatus(value: unknown): value is UsageStatus {
  return value === "provisional" || value === "final";
}

function hasValidDurations(value: Record<string, unknown>): boolean {
  const has5m = value.cacheWrite5mTokens !== undefined;
  const has1h = value.cacheWrite1hTokens !== undefined;
  if (!has5m && !has1h) return true;
  const { cacheWrite5mTokens = 0, cacheWrite1hTokens = 0, cacheWriteTokens } = value;
  if (!isCount(cacheWriteTokens) || !isCount(cacheWrite5mTokens) || !isCount(cacheWrite1hTokens)) return false;
  const sum = cacheWrite5mTokens + cacheWrite1hTokens;
  return has5m && has1h ? sum === cacheWriteTokens : sum <= cacheWriteTokens;
}

function hasValidCallFields(value: Record<string, unknown>): boolean {
  return [value.messageId, value.requestId, value.iterationId, value.turnId].every(field => field === undefined || isIdentifier(field))
    && (value.model === undefined || typeof value.model === "string")
    && (value.status === undefined || isUsageStatus(value.status))
    && (value.iterationId === undefined || isIdentifier(value.messageId) || isIdentifier(value.requestId));
}

export function isClaudeUsageReport(value: unknown): value is ClaudeUsageReport {
  return isRecord(value) && isTokenCounts(value) && isCount(value.inputTokens + value.outputTokens)
    && isUsageStatus(value.status) && isRecordedTimestamp(value.at)
    && (isIdentifier(value.messageId) || isIdentifier(value.requestId))
    && hasValidCallFields(value) && hasValidDurations(value);
}

export function isUsage(value: unknown): value is Usage {
  if (!isRecord(value)) return false;
  const { id, revision, at, kind, model } = value;
  if (!isIdentifier(id) || !isCount(revision) || revision < 1 || !isRecordedTimestamp(at) || !isTokenCounts(value)) return false;
  if (kind === "call") return hasValidCallFields(value) && hasValidDurations(value);
  const callFields = ["status", "messageId", "requestId", "turnId", "iterationId", "cacheWrite5mTokens", "cacheWrite1hTokens"];
  return callFields.every(field => value[field] === undefined)
    && ((kind === undefined && (model === undefined || typeof model === "string")) || (kind === "interval" && model === undefined));
}

export function isNativeCodexCall(usage: Usage): boolean {
  return usage.kind === "call" && (isIdentifier(usage.requestId) || /^call:native:[a-f0-9]{64}$/.test(usage.id));
}

/** Copies can report a native call at different times. Retain its first accepted observation. */
export function mergeCodexCall(known: Usage, incoming: Usage): Usage | null {
  if (known.kind !== "call" || incoming.kind !== "call" || known.id !== incoming.id
    || known.revision !== incoming.revision || known.inputTokens !== incoming.inputTokens
    || known.outputTokens !== incoming.outputTokens) return null;
  if (known.at !== incoming.at && !(isNativeCodexCall(known) && isNativeCodexCall(incoming))) return null;
  const merged = { ...known };
  for (const field of ["model", "turnId", "requestId", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
    const earlier = known[field];
    const later = incoming[field];
    if (later === undefined) continue;
    if (earlier !== undefined && earlier !== later) return null;
    Object.assign(merged, { [field]: later });
  }
  return isTokenCounts(merged) ? merged : null;
}
