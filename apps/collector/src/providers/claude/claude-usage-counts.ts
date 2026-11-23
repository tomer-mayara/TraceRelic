import type { CacheWriteDurations, TokenCounts, UsageDiagnosticCode } from "../../storage/collector-storage.ts";
import { JsonRecord } from "../../transcript/json-record.ts";

type Fields = Readonly<Record<string, unknown>>;
type CacheWrite = CacheWriteDurations & Pick<TokenCounts, "cacheWriteTokens">;
export type ReportIssue = (code: UsageDiagnosticCode, hasGap: boolean) => void;

export class ClaudeUsageCounts {
  private static durations(value: unknown): CacheWriteDurations | undefined {
    if (!JsonRecord.is(value) || Object.keys(value).some(key => key !== "ephemeral_5m_input_tokens" && key !== "ephemeral_1h_input_tokens")) return;
    const five = value.ephemeral_5m_input_tokens ?? undefined;
    const hour = value.ephemeral_1h_input_tokens ?? undefined;
    if ((five !== undefined && !JsonRecord.isCount(five)) || (hour !== undefined && !JsonRecord.isCount(hour))) return;
    return { ...(five !== undefined && { cacheWrite5mTokens: five }), ...(hour !== undefined && { cacheWrite1hTokens: hour }) };
  }

  private static cacheWrites(flat: number | undefined, breakdown: unknown, issue: ReportIssue): CacheWrite | undefined {
    const measured = flat === undefined ? {} : { cacheWriteTokens: flat };
    if (breakdown === undefined || breakdown === null) return measured;
    const parts = ClaudeUsageCounts.durations(breakdown);
    if (parts) {
      const { cacheWrite5mTokens: five, cacheWrite1hTokens: hour } = parts;
      const sum = (five ?? 0) + (hour ?? 0);
      if (five !== undefined && hour !== undefined && JsonRecord.isCount(sum) && (flat === undefined || flat === sum)) {
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

  static read(usage: Fields, issue: ReportIssue): (TokenCounts & CacheWriteDurations) | undefined {
    const { input_tokens: input, output_tokens: output } = usage;
    const read = usage.cache_read_input_tokens ?? undefined;
    const write = usage.cache_creation_input_tokens ?? undefined;
    if (!JsonRecord.isCount(input) || !JsonRecord.isCount(output) || (read !== undefined && !JsonRecord.isCount(read)) || (write !== undefined && !JsonRecord.isCount(write))) {
      issue("invalid-claude-usage", true);
      return;
    }
    const writes = ClaudeUsageCounts.cacheWrites(write, usage.cache_creation, issue);
    if (!writes) return;
    const inputTokens = input + (read ?? 0) + (writes.cacheWriteTokens ?? 0);
    if (!JsonRecord.isCount(inputTokens + output)) {
      issue("invalid-claude-usage", true);
      return;
    }
    return { inputTokens, outputTokens: output, ...(read !== undefined && { cacheReadTokens: read }), ...writes };
  }
}
