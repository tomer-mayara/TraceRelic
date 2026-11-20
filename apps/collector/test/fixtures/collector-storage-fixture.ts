import type { Batch, Message, StreamKey, Usage } from "../../src/storage/collector-storage.ts";

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

export function prompt(text: string): Message {
  return {
    id: "message-1", role: "user", at: observedAt, text, sourceOrder: 2, blockIndex: 0,
    turnId: "turn-1", requestId: "request-1", context: { cwd: "/demo", repository: "trace", branch: "topic" },
  };
}

export function observation(inputTokens: number, outputTokens: number, revision = 1): Usage {
  return { id: "request-1/message-1", at: observedAt, model: "example-model", revision, inputTokens, outputTokens };
}
