import type { ClaudeCallOrigin, ClaudeUsageReport, StreamKey } from "../../src/storage/collector-storage.ts";
import { planning } from "./collector-storage-fixture.ts";

export const child: StreamKey = { harness: "claude", sessionId: "child", streamId: "child.jsonl", installationId: "laptop" };
export const parent: StreamKey = { harness: "claude", sessionId: "parent", streamId: "parent.jsonl", installationId: "desktop" };

export function call(messageId: string, requestId: string, tokens: number, origin: ClaudeCallOrigin): ClaudeUsageReport {
  return { messageId, requestId, inputTokens: tokens, outputTokens: 0, at: planning.at, status: "final", origin };
}

export const original: ClaudeCallOrigin = {
  kind: "own", transcriptUuid: "original-row", sourceOrder: 1, byteRange: { startOffset: 0, endOffset: 3 },
};
export const markedCopy: ClaudeCallOrigin = {
  ...original, kind: "copy", parentSessionId: parent.sessionId, transcriptUuid: "remapped-row", parentMessageUuid: original.transcriptUuid,
};
export const ownChild: ClaudeCallOrigin = {
  kind: "own", transcriptUuid: "child-row", parentSessionId: parent.sessionId, sourceOrder: 2, byteRange: { startOffset: 3, endOffset: 7 },
};
