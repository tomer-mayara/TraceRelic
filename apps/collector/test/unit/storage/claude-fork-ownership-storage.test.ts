import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClaudeCallOrigin } from "@tracerelic/collector/storage";
import { call, child, markedCopy, original, ownChild, parent } from "../../fixtures/claude-ownership-storage-fixture.ts";
import { batch, codexSource, planning } from "../../fixtures/collector-storage-fixture.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";

test("a late parent resolves the first uncertain Claude row without advancing the child's checkpoint", async () => {
  const store = new InMemoryCollectorStorage();
  const inherited = call("shared-message", "rewritten-request", 100, markedCopy);
  const own = call("new-message", "child-request", 25, ownChild);
  const before = batch(0, 0, { source: child, metadata: { parentSessionId: parent.sessionId }, messages: [planning],
    claudeUsageReports: [inherited, own] });
  assert.equal(await store.commit(before), "committed");
  const pending = await store.readSession(child);
  assert.equal(pending?.observedTotalTokens, 25);
  assert.equal(pending.coverage, "partial");
  assert.deepEqual(pending.usageDiagnostics, [{ code: "unresolved-claude-fork", sourceOrder: 1, byteRange: markedCopy.byteRange,
    installationId: child.installationId, streamId: child.streamId }]);

  const fromParent = batch(0, 0, { source: parent, claudeUsageReports: [call("shared-message", "original-request", 100, original)] });
  assert.equal(await store.commit({ ...fromParent, messages: [{ ...planning, role: "tool" as "user" }] }), "invalid");
  assert.deepEqual(await store.readCheckpoint(child), { version: 1, checkpoint: before.checkpoint });
  assert.deepEqual(await store.readSession(child), pending);
  const overflow = call("larger", "too-large", Number.MAX_SAFE_INTEGER, { ...original, transcriptUuid: "larger" });
  assert.equal(await store.commit({ ...fromParent, claudeUsageReports: [...fromParent.claudeUsageReports ?? [], overflow] }), "invalid");
  assert.equal(await store.readSession(parent), null);
  assert.deepEqual(await store.readCheckpoint(child), { version: 1, checkpoint: before.checkpoint });
  assert.deepEqual(await store.readSession(child), pending);
  assert.equal(await store.commit(fromParent), "committed");
  assert.equal((await store.readSession(parent))?.observedTotalTokens, 100);
  const resolved = await store.readSession(child);
  assert.equal(resolved?.coverage, "reported");
  assert.equal(resolved.observedTotalTokens, 25);
  assert.equal(resolved.usageDiagnostics, undefined);
  assert.deepEqual(resolved.messages, [planning]);
  assert.deepEqual(resolved.usage, pending.usage);
  assert.deepEqual(await store.readCheckpoint(child), { version: 2, checkpoint: before.checkpoint });
  assert.equal(await store.commit(batch(1, 10, { source: child })), "conflict");
  assert.equal(await store.commit(fromParent), "conflict");
  assert.deepEqual(await store.readSession(child), resolved);
});

test("a proven parent takes ownership of a previously counted subagent call and preserves a damage diagnostic", async () => {
  const store = new InMemoryCollectorStorage();
  const reported = call("shared", "provider-request", 100, { ...ownChild, sourceOrder: 1, byteRange: original.byteRange });
  const later = call("other", "child-request", 25, { ...ownChild, transcriptUuid: "own-other" });
  const damage = { code: "malformed-transcript-line" as const, sourceOrder: 3, byteRange: { startOffset: 7, endOffset: 9 } };
  const initial = batch(0, 0, { source: child, metadata: { parentSessionId: parent.sessionId }, claudeUsageReports: [reported, later],
    usageDiagnostics: [damage] });
  assert.equal(await store.commit(initial), "committed");
  assert.equal((await store.readSession(child))?.observedTotalTokens, 125);
  const first = batch(0, 0, { source: parent, claudeUsageReports: [call("shared", "provider-request", 100, original)] });
  assert.equal(await store.commit(first), "committed");
  const view = await store.readSession(child);
  assert.equal(view?.observedTotalTokens, 25);
  assert.equal(view.coverage, "partial");
  assert.deepEqual(view.usageDiagnostics, [{ ...damage, streamId: child.streamId, installationId: child.installationId }]);
  assert.equal((await store.readCheckpoint(child)).version, 2);
  assert.equal((await store.readSession(parent))?.observedTotalTokens, 100);
});

test("a rejected origin leaves both sessions and the workspace ownership index unchanged", async () => {
  const store = new InMemoryCollectorStorage();
  const claimed = call("one", "request", 100, markedCopy);
  const unconfirmed = batch(0, 0, { source: child, metadata: { parentSessionId: parent.sessionId }, claudeUsageReports: [claimed] });
  assert.equal(await store.commit(unconfirmed), "committed");
  const before = await store.readSession(child);
  for (const invalid of [
    null, { ...original, kind: "unknown" }, { ...original, sourceOrder: 0 }, { ...original, transcriptUuid: "" },
    { ...original, byteRange: { startOffset: 4, endOffset: 4 } }, { ...original, byteRange: { startOffset: 0, endOffset: 11 } },
  ] as unknown as ClaudeCallOrigin[]) {
    const report = call("one", "request", 100, invalid);
    assert.equal(await store.commit(batch(0, 0, { source: parent, messages: [planning], claudeUsageReports: [report] })), "invalid");
    assert.equal(await store.readSession(parent), null);
    assert.deepEqual(await store.readCheckpoint(child), { version: 1, checkpoint: unconfirmed.checkpoint });
    assert.deepEqual(await store.readSession(child), before);
  }
  assert.equal(await store.commit(batch(0, 0, { source: codexSource, claudeUsageReports: [claimed] })), "invalid");
});

test("a withheld copy cannot overflow the child's visible total", async () => {
  const store = new InMemoryCollectorStorage();
  const inherited = call("large", "large-r", Number.MAX_SAFE_INTEGER, markedCopy);
  const own = call("small", "small-r", 25, ownChild);
  assert.equal(await store.commit(batch(0, 0, { source: child, metadata: { parentSessionId: parent.sessionId },
    claudeUsageReports: [inherited, own] })), "committed");
  assert.equal((await store.readSession(child))?.observedTotalTokens, 25);
  assert.equal(await store.commit(batch(0, 0, { source: parent, claudeUsageReports: [{ ...inherited, origin: original }] })), "committed");
  assert.equal((await store.readSession(parent))?.observedTotalTokens, Number.MAX_SAFE_INTEGER);
  assert.equal((await store.readSession(child))?.observedTotalTokens, 25);
});

test("a marked checkpoint requires an origin on every Claude report, including a backfill at the accepted byte", async () => {
  const store = new InMemoryCollectorStorage();
  const report = call("one", "request", 100, original);
  const legacy = { ...report, origin: undefined };
  const saved = { offset: 10, prefixDigest: "e".repeat(64), parserState: "{}" };
  const marked = { ...saved, claudeCallOrigins: true as const };
  const first = batch(0, 0, { source: parent, checkpoint: marked, claudeUsageReports: [report, legacy] });
  assert.equal(await store.commit(first), "invalid");
  assert.equal(await store.readSession(parent), null);
  assert.equal(await store.commit({ ...first, checkpoint: saved, claudeUsageReports: [legacy] }), "committed");
  const backfill = batch(1, 10, { source: parent, checkpoint: marked, backfillClaudeOriginsFrom: saved });
  assert.equal(await store.commit({ ...backfill, claudeUsageReports: [legacy] }), "invalid");
  assert.deepEqual(await store.readCheckpoint(parent), { version: 1, checkpoint: saved });
  assert.equal(await store.commit({ ...backfill, claudeUsageReports: [report] }), "committed");
});

test("a source row pointer needs a linked copy and unmarked subagent evidence needs its native parent", async () => {
  const store = new InMemoryCollectorStorage();
  for (const origin of [
    { ...original, parentMessageUuid: "unlinked" }, { ...original, kind: "subagent" as const },
    { ...markedCopy, parentSessionId: undefined }, { ...ownChild, parentMessageUuid: "not-a-copy" },
  ]) {
    const report = call("one", "request", 100, origin);
    assert.equal(await store.commit(batch(0, 0, { source: child, claudeUsageReports: [report] })), "invalid");
  }
  const unknown = call("one", "request", 100, { ...original, kind: "copy" });
  assert.equal(await store.commit(batch(0, 0, { source: child, claudeUsageReports: [unknown] })), "committed");
  assert.equal((await store.readSession(child))?.observedTotalTokens, null);
});
