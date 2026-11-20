import type { StreamKey, TokenCounts, Usage, UsageWindow } from "../../src/storage/collector-storage.ts";

export const rollout: StreamKey = { harness: "codex", sessionId: "planning", streamId: "active" };
export const archivedCopy: StreamKey = { ...rollout, streamId: "archived", installationId: "second" };
export const history = "verified:planning-origin";

export function counts(inputTokens: number, outputTokens: number, fields: Partial<TokenCounts> = {}): TokenCounts {
  return { inputTokens, outputTokens, ...fields };
}

export function window(
  start: TokenCounts, end: TokenCounts, id: string, kind: "call" | "interval" = "interval",
): UsageWindow {
  const part: Usage = {
    id, kind, revision: 1, at: "2026-01-01T00:00:00Z",
    ...(kind === "call" && { requestId: id }),
    inputTokens: end.inputTokens - start.inputTokens, outputTokens: end.outputTokens - start.outputTokens,
  };
  return { historyId: history, start, end, parts: [part] };
}

export const zero = counts(0, 0);
export const first = counts(90, 30);
export const last = counts(160, 40);
export const coarse = window(zero, last, "coarse");
export const earlier = window(zero, first, "earlier");
export const later = window(first, last, "later", "call");
