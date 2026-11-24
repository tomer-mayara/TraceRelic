import type { TokenCounts } from "../../storage/collector-storage.ts";
import { JsonRecord } from "../../transcript/json-record.ts";
import { ParserState } from "../../scan/parser-state.ts";

export const breakdowns = ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const;
export type Breakdown = typeof breakdowns[number];
export const zero: TokenCounts = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

/** The token counts of Codex usage reports: how to read, compare, subtract and divide them. */
export class CodexTokenCounts {
  // Input includes cache reads and writes. Output includes reasoning.
  private static counts(input: unknown, output: unknown, read: unknown, write: unknown, reasoning: unknown): TokenCounts | undefined {
    if (!JsonRecord.isCount(input) || !JsonRecord.isCount(output) || !JsonRecord.isCount(input + output)) return;
    const tokens: TokenCounts = { inputTokens: input, outputTokens: output };
    if (JsonRecord.isCount(read) && read <= input) tokens.cacheReadTokens = read;
    if (JsonRecord.isCount(write) && write <= input) tokens.cacheWriteTokens = write;
    if ((tokens.cacheReadTokens ?? 0) + (tokens.cacheWriteTokens ?? 0) > input) {
      delete tokens.cacheReadTokens;
      delete tokens.cacheWriteTokens;
    }
    if (JsonRecord.isCount(reasoning) && reasoning <= output) tokens.reasoningTokens = reasoning;
    return tokens;
  }

  static fromProvider(value: unknown): TokenCounts | undefined {
    const raw = JsonRecord.object(value);
    if (!raw) return;
    const parsed = CodexTokenCounts.counts(raw.input_tokens, raw.output_tokens, raw.cached_input_tokens, raw.cache_write_input_tokens, raw.reasoning_output_tokens);
    if (parsed && (raw.total_tokens === undefined || raw.total_tokens === parsed.inputTokens + parsed.outputTokens)) return parsed;
  }

  static restore(value: unknown): TokenCounts {
    const raw = ParserState.record(value, ["inputTokens", "outputTokens", ...breakdowns]);
    const parsed = CodexTokenCounts.counts(raw.inputTokens, raw.outputTokens, raw.cacheReadTokens, raw.cacheWriteTokens, raw.reasoningTokens);
    if (!parsed || breakdowns.some(key => raw[key] !== parsed[key])) ParserState.invalid();
    return parsed;
  }

  static sameTotals(first: TokenCounts, second: TokenCounts): boolean {
    return first.inputTokens === second.inputTokens && first.outputTokens === second.outputTokens;
  }

  /** Repeated snapshots can supply previously missing detail. Disagreement at an unchanged total
   * makes that field an unreliable starting point, including on replay of either value. */
  static mergeRepeated(baseline: TokenCounts, next: TokenCounts, disputed: Set<Breakdown>): void {
    for (const key of breakdowns) {
      const incoming = next[key];
      if (incoming === undefined || disputed.has(key)) continue;
      if (baseline[key] === undefined || baseline[key] === incoming) baseline[key] = incoming;
      else disputed.add(key);
    }
    if ((baseline.cacheReadTokens ?? 0) + (baseline.cacheWriteTokens ?? 0) > baseline.inputTokens) {
      disputed.add("cacheReadTokens");
      disputed.add("cacheWriteTokens");
    }
    for (const key of disputed) delete baseline[key];
  }

  /** Unknown subcounts stay unknown unless their inclusive count proves they must be zero. */
  static minus(end: TokenCounts, start: TokenCounts): TokenCounts | undefined {
    const optional = (key: Breakdown, total: "inputTokens" | "outputTokens") => {
      const from = start[key] ?? (start[total] === 0 ? 0 : undefined);
      const to = end[key];
      return to !== undefined && from !== undefined ? to - from : undefined;
    };
    return CodexTokenCounts.counts(end.inputTokens - start.inputTokens, end.outputTokens - start.outputTokens,
      optional("cacheReadTokens", "inputTokens"), optional("cacheWriteTokens", "inputTokens"),
      optional("reasoningTokens", "outputTokens"));
  }

  /** Check the inclusive endpoints first, then constrain each known subcount by the
   * input or output still available in the residual and calls that omit that field. */
  static partition(change: TokenCounts, calls: readonly TokenCounts[]) {
    const remaining: TokenCounts = { inputTokens: change.inputTokens, outputTokens: change.outputTokens };
    for (const call of calls) {
      remaining.inputTokens -= call.inputTokens;
      remaining.outputTokens -= call.outputTokens;
      if (remaining.inputTokens < 0 || remaining.outputTokens < 0) return;
    }
    const disputed: Breakdown[] = [];
    for (const key of breakdowns) {
      let rest = change[key];
      if (rest === undefined) continue;
      const parent = key === "reasoningTokens" ? "outputTokens" : "inputTokens";
      let unmeasured = 0;
      for (const call of calls) {
        const reported = call[key];
        if (reported === undefined) unmeasured += call[parent];
        else rest -= reported;
      }
      if (rest < 0 || rest > remaining[parent] + unmeasured) disputed.push(key);
      else if (unmeasured === 0) remaining[key] = rest;
    }
    if ((remaining.cacheReadTokens ?? 0) + (remaining.cacheWriteTokens ?? 0) > remaining.inputTokens) {
      disputed.push("cacheReadTokens", "cacheWriteTokens");
      delete remaining.cacheReadTokens;
      delete remaining.cacheWriteTokens;
    }
    return { remaining, disputed };
  }
}
