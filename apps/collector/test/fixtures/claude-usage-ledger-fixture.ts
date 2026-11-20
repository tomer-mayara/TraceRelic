import type { ClaudeUsageReport } from "../../src/storage/collector-storage.ts";

export const initial: ClaudeUsageReport = {
  at: "2026-02-01T12:00:01Z", messageId: "message-a", requestId: "request-a", status: "provisional",
  inputTokens: 40, outputTokens: 2, cacheReadTokens: 25, cacheWriteTokens: 5,
};

export const completed: ClaudeUsageReport = {
  ...initial, at: "2026-02-01T12:01:19Z", status: "final", outputTokens: 91,
};

export const independent: ClaudeUsageReport = {
  ...initial, messageId: "message-b", requestId: "request-b", turnId: "next-turn",
};
