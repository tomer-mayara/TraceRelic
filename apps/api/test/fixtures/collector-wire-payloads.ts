import type { AcknowledgedSource, Batch, PresenceWrite, SessionKey, SessionView, SourceScope } from "@tracerelic/collector/storage";

export const key = { harness: "codex", sessionId: "plan" } satisfies SessionKey;
export const source = { ...key, streamId: "rollout.jsonl" };
const location = { root: "/history", path: source.streamId, cwd: "/work/plan" };
const at = "2026-01-01T12:00:00Z";
export const scope = { harness: key.harness, root: location.root, sessionIds: ["plan"], projectPaths: [location.cwd] } satisfies SourceScope;
export const batch = {
  source, sourceObservation: { location, observedEnd: 100 },
  expectedVersion: 0, expectedOffset: 0, checkpoint: { offset: 100, parserState: "{}", prefixDigest: "a".repeat(64) },
  metadata: { cwd: location.cwd, branch: "topic" }, branchObservation: { sourceOrder: 1, at },
  messages: [{ id: "m", at, role: "user", text: "Plan a chat", sourceOrder: 1, blockIndex: 0 }],
  usage: [{ id: "call", at, revision: 1, kind: "call", inputTokens: 120, outputTokens: 10, cacheReadTokens: 16 }],
} satisfies Batch;
export const presence = {
  source, location, observedEnd: 100, expectedVersion: 1, expectedOffset: 100, presence: "missing",
} satisfies PresenceWrite;
export const storedSource = {
  source: { ...source, installationId: "desktop" }, location, observedEnd: 100, version: 1, acceptedOffset: 100, presence: "present",
} satisfies AcknowledgedSource;
export const session = {
  key, metadata: batch.metadata, messages: batch.messages, usage: batch.usage, observedTotalTokens: 130, coverage: "reported",
} satisfies SessionView;
