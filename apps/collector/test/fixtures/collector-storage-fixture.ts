import type {
  Batch, ClaudeUsageReport, Message, StreamKey, TokenCounts, Usage, UsageKind, UsageWindow,
} from "../../src/storage/collector-storage.ts";

const observedAt = "2026-01-01T00:00:00Z";

export const source: StreamKey = { harness: "claude", sessionId: "chat-1", streamId: "main-v1" };
export const planning: Message = {
  id: "m1", at: observedAt, role: "user", text: "Plan the search feature",
};

export function batch(expectedVersion: number, expectedOffset: number, fields: Partial<Batch> = {}): Batch {
  return {
    source, expectedVersion, expectedOffset, checkpoint: { offset: expectedOffset + 10, parserState: "{}" },
    messages: [], usage: [], ...fields,
  };
}

export function initialPlanningBatch(): Batch {
  return batch(0, 0, {
    source: { harness: "claude", sessionId: "planning", streamId: "main" },
    checkpoint: { offset: 100, parserState: "{}" },
  });
}

export function request(fields: Partial<Usage> = {}): Usage {
  return {
    id: "req-1/msg-1", revision: 1, at: planning.at,
    inputTokens: 40, outputTokens: 2, ...fields,
  };
}

export function claudeReport(fields: Partial<ClaudeUsageReport> = {}): ClaudeUsageReport {
  return {
    messageId: "message", requestId: "request", at: observedAt, status: "provisional",
    inputTokens: 40, cacheReadTokens: 25, cacheWriteTokens: 5, outputTokens: 2, ...fields,
  };
}

export function claudeParserState(version: 1 | 2, occurrences: Record<string, number> = {}, lineNumber = 2): string {
  return JSON.stringify({ version, lineNumber, decoder: { occurrences } });
}

export function prompt(text: string): Message {
  return {
    id: "message-1", role: "user", at: observedAt, text, sourceOrder: 2, blockIndex: 0,
    turnId: "turn-1", requestId: "request-1", context: { cwd: "/demo", repository: "trace", branch: "topic" },
  };
}

export function observation(inputTokens: number, outputTokens: number, revision = 1): Usage {
  return { id: "request-1/message-1", at: observedAt, model: "example-model", revision, inputTokens, outputTokens };
}

export const codexSource: StreamKey = { harness: "codex", sessionId: "measured", streamId: "rollout" };

function counters(tokens: number): TokenCounts {
  const outputTokens = Math.floor(tokens / 5);
  return { inputTokens: tokens - outputTokens, outputTokens };
}

export function codexMeasurement(id: string, kind: UsageKind, tokens: number): Usage {
  return { id, kind, ...counters(tokens), at: observedAt, revision: 1 };
}

export function codexWindow(start: number, end: number, ...parts: Usage[]): UsageWindow {
  return { historyId: "recorded-origin", start: counters(start), end: counters(end), parts };
}

export function codexParserState(version: 1 | 2, lineNumber = 2): string {
  const chat = { context: {}, mirrors: {}, occurrences: {} };
  const decoder = version === 1 ? chat : { chat, usage: { observations: [], disputed: [], seen: {}, pending: [] } };
  return JSON.stringify({ version, lineNumber, decoder });
}
