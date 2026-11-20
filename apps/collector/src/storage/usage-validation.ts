import { isRecordedTimestamp } from "../recorded-timestamp.ts";
import type { TokenCounts, Usage } from "./collector-storage.ts";

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

export function isUsage(value: unknown): value is Usage {
  if (!isRecord(value)) return false;
  const { id, revision, at, kind, model, turnId, requestId } = value;
  return isIdentifier(id) && isCount(revision) && revision > 0 && isRecordedTimestamp(at)
    && isTokenCounts(value)
    && (kind === undefined || kind === "call" || kind === "interval")
    && (model === undefined || (kind !== "interval" && typeof model === "string"))
    && (turnId === undefined || (kind === "call" && isIdentifier(turnId)))
    && (requestId === undefined || (kind === "call" && isIdentifier(requestId)));
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
