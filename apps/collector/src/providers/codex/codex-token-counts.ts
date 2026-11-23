import type { TokenCounts } from "../../storage/collector-storage.ts";
import { invalidState, stateRecord } from "../../scan/parser-state.ts";

export const breakdowns = ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const;
export type Breakdown = typeof breakdowns[number];
export const zero: TokenCounts = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

type Fields = Readonly<Record<string, unknown>>;

export function object(value: unknown): Fields | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Fields;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// Input includes cache reads and writes. Output includes reasoning.
function counts(input: unknown, output: unknown, read: unknown, write: unknown, reasoning: unknown): TokenCounts | undefined {
  if (!count(input) || !count(output) || !count(input + output)) return;
  const tokens: TokenCounts = { inputTokens: input, outputTokens: output };
  if (count(read) && read <= input) tokens.cacheReadTokens = read;
  if (count(write) && write <= input) tokens.cacheWriteTokens = write;
  if ((tokens.cacheReadTokens ?? 0) + (tokens.cacheWriteTokens ?? 0) > input) {
    delete tokens.cacheReadTokens;
    delete tokens.cacheWriteTokens;
  }
  if (count(reasoning) && reasoning <= output) tokens.reasoningTokens = reasoning;
  return tokens;
}

export function providerCounts(value: unknown): TokenCounts | undefined {
  const raw = object(value);
  if (!raw) return;
  const parsed = counts(raw.input_tokens, raw.output_tokens, raw.cached_input_tokens, raw.cache_write_input_tokens, raw.reasoning_output_tokens);
  if (parsed && (raw.total_tokens === undefined || raw.total_tokens === parsed.inputTokens + parsed.outputTokens)) return parsed;
}

export function restoredCounts(value: unknown): TokenCounts {
  const raw = stateRecord(value, ["inputTokens", "outputTokens", ...breakdowns]);
  const parsed = counts(raw.inputTokens, raw.outputTokens, raw.cacheReadTokens, raw.cacheWriteTokens, raw.reasoningTokens);
  if (!parsed || breakdowns.some(key => raw[key] !== parsed[key])) invalidState();
  return parsed;
}

export function sameTotals(first: TokenCounts, second: TokenCounts): boolean {
  return first.inputTokens === second.inputTokens && first.outputTokens === second.outputTokens;
}

/** Repeated snapshots can supply previously missing detail. Disagreement at an unchanged total
 * makes that field an unreliable starting point, including on replay of either value. */
export function mergeRepeated(baseline: TokenCounts, next: TokenCounts, disputed: Set<Breakdown>): void {
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
export function difference(end: TokenCounts, start: TokenCounts): TokenCounts | undefined {
  const optional = (key: Breakdown, total: "inputTokens" | "outputTokens") => {
    const from = start[key] ?? (start[total] === 0 ? 0 : undefined);
    const to = end[key];
    return to !== undefined && from !== undefined ? to - from : undefined;
  };
  return counts(end.inputTokens - start.inputTokens, end.outputTokens - start.outputTokens,
    optional("cacheReadTokens", "inputTokens"), optional("cacheWriteTokens", "inputTokens"),
    optional("reasoningTokens", "outputTokens"));
}

/** Check the inclusive endpoints first, then constrain each known subcount by the
 * input or output still available in the residual and calls that omit that field. */
export function partition(change: TokenCounts, calls: readonly TokenCounts[]) {
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
