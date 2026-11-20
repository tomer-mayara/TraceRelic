import type { CacheWriteDurations, TokenCounts, UsageDiagnosticCode } from "../storage/collector-storage.ts";

type Fields = Readonly<Record<string, unknown>>;
type CacheWrite = CacheWriteDurations & Pick<TokenCounts, "cacheWriteTokens">;
export type ReportIssue = (code: UsageDiagnosticCode, hasGap: boolean) => void;

export function isObject(value: unknown): value is Fields {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function durations(value: unknown): CacheWriteDurations | undefined {
  if (!isObject(value) || Object.keys(value).some(key => key !== "ephemeral_5m_input_tokens" && key !== "ephemeral_1h_input_tokens")) return;
  const five = value.ephemeral_5m_input_tokens ?? undefined;
  const hour = value.ephemeral_1h_input_tokens ?? undefined;
  if ((five !== undefined && !isCount(five)) || (hour !== undefined && !isCount(hour))) return;
  return { ...(five !== undefined && { cacheWrite5mTokens: five }), ...(hour !== undefined && { cacheWrite1hTokens: hour }) };
}

function cacheWrites(flat: number | undefined, breakdown: unknown, issue: ReportIssue): CacheWrite | undefined {
  const measured = flat === undefined ? {} : { cacheWriteTokens: flat };
  if (breakdown === undefined || breakdown === null) return measured;
  const parts = durations(breakdown);
  if (parts) {
    const { cacheWrite5mTokens: five, cacheWrite1hTokens: hour } = parts;
    const sum = (five ?? 0) + (hour ?? 0);
    if (five !== undefined && hour !== undefined && isCount(sum) && (flat === undefined || flat === sum)) {
      return { cacheWriteTokens: sum, ...parts };
    }
    if ((five === undefined || hour === undefined) && flat !== undefined && sum <= flat) {
      issue("unsupported-claude-cache-breakdown", false);
      return { ...measured, ...parts };
    }
  }
  // The flat counter measures all writes even if their duration cannot be established.
  issue("unsupported-claude-cache-breakdown", flat === undefined);
  if (flat !== undefined) return measured;
}

export class ClaudeUsageCounts {
  static read(usage: Fields, issue: ReportIssue): (TokenCounts & CacheWriteDurations) | undefined {
    const { input_tokens: input, output_tokens: output } = usage;
    const read = usage.cache_read_input_tokens ?? undefined;
    const write = usage.cache_creation_input_tokens ?? undefined;
    if (!isCount(input) || !isCount(output) || (read !== undefined && !isCount(read)) || (write !== undefined && !isCount(write))) {
      issue("invalid-claude-usage", true);
      return;
    }
    const writes = cacheWrites(write, usage.cache_creation, issue);
    if (!writes) return;
    const inputTokens = input + (read ?? 0) + (writes.cacheWriteTokens ?? 0);
    if (!isCount(inputTokens + output)) {
      issue("invalid-claude-usage", true);
      return;
    }
    return { inputTokens, outputTokens: output, ...(read !== undefined && { cacheReadTokens: read }), ...writes };
  }
}
