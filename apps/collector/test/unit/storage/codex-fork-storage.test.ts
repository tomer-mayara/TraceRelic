import assert from "node:assert/strict";
import { test } from "node:test";
import { batch, codexMeasurement, codexSource, codexWindow, planning } from "../../fixtures/collector-storage-fixture.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";

const child = { ...codexSource, sessionId: "child" };
const parent = { ...codexSource, sessionId: "parent" };
const saved = { offset: 20, parserState: "old", prefixDigest: "a".repeat(64) };
const fork = { parentSessionId: "parent", inheritedThrough: { lineNumber: 1, offset: 5 },
  baseline: { inputTokens: 80, outputTokens: 20 } };
const repaired = { ...saved, parserState: "repaired", codexFork: fork };
const providerId = "c".repeat(64);

test("fork reconciliation replaces only usage from this generation of the verified stream", async () => {
  const store = new InMemoryCollectorStorage();
  const prior = codexMeasurement("accepted-before-rewrite", "call", 4);
  const other = codexMeasurement("from-another-stream", "call", 8);
  const inherited = codexMeasurement("copied-interval", "interval", 100);
  const own = codexMeasurement("own-interval", "interval", 25);
  const first = { ...saved, offset: 10, prefixDigest: "b".repeat(64) };
  const sister = { ...child, streamId: "other-rollout" };
  assert.equal(await store.commit(batch(0, 0, { source: child, checkpoint: first, usage: [prior] })), "committed");
  assert.equal(await store.commit(batch(1, 10, { source: child, checkpoint: saved, resetFrom: first,
    messages: [planning], usageWindows: [codexWindow(0, 100, inherited)], hasGap: true })), "committed");
  assert.equal(await store.commit(batch(2, 0, { source: sister, usage: [other] })), "committed");
  const before = await store.readSession(child);
  assert.equal(before?.observedTotalTokens, 112);
  const correction = batch(3, saved.offset, { source: child, checkpoint: repaired, reconcileCodexForkFrom: saved,
    metadata: { parentSessionId: "parent" }, usageWindows: [codexWindow(100, 125, own)] });
  for (const fields of [
    { checkpoint: { ...repaired, offset: 19 } }, { checkpoint: { ...repaired, prefixDigest: "d".repeat(64) } },
    { checkpoint: { ...repaired, codexFork: undefined } }, { resetFrom: saved }, { upgradeFromParserState: "old" },
    { messages: [{ ...planning, text: "replacement" }] },
    { usageWindows: [codexWindow(100, 126, own)] },
  ]) assert.equal(await store.commit({ ...correction, ...fields }), "invalid");
  assert.equal(await store.commit({ ...correction, reconcileCodexForkFrom: { ...saved, parserState: "stale" } }), "conflict");
  assert.deepEqual(await store.readSession(child), before);
  assert.equal(await store.commit(correction), "committed");
  assert.equal(await store.commit(correction), "conflict");
  const view = await store.readSession(child);
  assert.deepEqual(view?.usage, [prior, other, own]);
  assert.equal(view?.observedTotalTokens, 37);
  assert.equal(view?.coverage, "partial");
  assert.deepEqual(view?.messages, [planning]);
  assert.deepEqual(view?.metadata, { parentSessionId: "parent" });
  assert.deepEqual(await store.readCheckpoint(child), { version: 4, checkpoint: repaired });
  assert.equal((await store.readCheckpoint(sister)).checkpoint?.offset, 10);
});

test("a verified parent takes ownership of its native call in one versioned workspace update", async () => {
  const store = new InMemoryCollectorStorage();
  const copied = { ...codexMeasurement("child-scoped-id", "call", 25), requestId: "provider-request" };
  const original = { ...copied, id: "parent-scoped-id" };
  const unrelated = codexMeasurement("child-other", "call", 7);
  const claim = { providerId, usageId: copied.id, ownerSessionId: child.sessionId };
  const childBatch = batch(0, 0, { source: child, usage: [copied, unrelated], checkpoint: repaired,
    metadata: { parentSessionId: parent.sessionId }, codexCallClaims: [claim] });
  assert.equal(await store.commit(childBatch), "committed");
  const parentBatch = batch(0, 0, { source: parent, usage: [original],
    codexCallClaims: [{ ...claim, usageId: original.id, ownerSessionId: parent.sessionId }] });
  assert.equal(await store.commit({ ...parentBatch, usage: [{ ...original, inputTokens: -1 }] }), "invalid");
  assert.equal((await store.readSession(child))?.observedTotalTokens, 32);
  assert.equal(await store.commit(parentBatch), "committed");
  assert.equal((await store.readSession(parent))?.observedTotalTokens, 25);
  assert.deepEqual((await store.readSession(child))?.usage, [unrelated]);
  assert.deepEqual(await store.readCheckpoint(child), { version: 2, checkpoint: repaired });
  const next = batch(1, 20, { source: child, checkpoint: { ...repaired, offset: 30 } });
  assert.equal(await store.commit(next), "conflict");
  assert.equal(await store.commit({ ...next, expectedVersion: 2, usage: [copied], codexCallClaims: [claim] }), "committed");
  assert.equal((await store.readSession(child))?.observedTotalTokens, 7);
  assert.equal((await store.readCheckpoint(parent)).version, 1);
  const other = new InMemoryCollectorStorage();
  assert.equal(await other.commit(childBatch), "committed");
  assert.equal((await other.readSession(child))?.observedTotalTokens, 32);
});

test("unresolved fork diagnostics require a Codex range and retain the reported gap", async () => {
  const store = new InMemoryCollectorStorage();
  const diagnostic = { code: "unresolved-codex-fork", sourceOrder: 2, byteRange: { startOffset: 3, endOffset: 10 } } as const;
  assert.equal(await store.commit(batch(0, 0, { usageDiagnostics: [diagnostic] })), "invalid");
  assert.equal(await store.commit(batch(0, 0, { source: child, usageDiagnostics: [{ ...diagnostic, byteRange: undefined }] })), "invalid");
  assert.equal(await store.commit(batch(0, 0, { source: child, usageDiagnostics: [diagnostic, diagnostic] })), "committed");
  assert.deepEqual((await store.readSession(child))?.usageDiagnostics, [{ ...diagnostic, streamId: child.streamId }]);
  assert.equal(await store.commit(batch(1, 10, { source: child, usage: [codexMeasurement("known", "call", 12)] })), "committed");
  assert.equal((await store.readSession(child))?.coverage, "partial");
});

test("late fork proof restores an existing parent's claim when the correction removes its copy", async () => {
  const store = new InMemoryCollectorStorage();
  const copied = { ...codexMeasurement("child-scoped-id", "call", 25), requestId: "one" };
  const original = { ...copied, id: "parent-scoped-id" };
  const claim = { providerId, usageId: copied.id, ownerSessionId: child.sessionId };
  const pending = { ...saved, codexFork: { parentSessionId: "parent", firstUncertain: { lineNumber: 2, offset: 9 } } };
  assert.equal(await store.commit(batch(0, 0, { source: child, usage: [copied], checkpoint: pending, codexCallClaims: [claim] })), "committed");
  assert.equal(await store.commit(batch(0, 0, { source: parent, usage: [original],
    codexCallClaims: [{ ...claim, ownerSessionId: parent.sessionId, usageId: original.id }] })), "committed");
  assert.equal((await store.readSession(child))?.observedTotalTokens, 25);
  assert.equal((await store.readSession(parent))?.observedTotalTokens, null);
  const correction = batch(1, 20, { source: child, checkpoint: repaired, reconcileCodexForkFrom: pending });
  assert.equal(await store.commit(correction), "committed");
  assert.equal((await store.readSession(child))?.observedTotalTokens, null);
  assert.equal((await store.readSession(parent))?.observedTotalTokens, 25);
  assert.equal((await store.readCheckpoint(parent)).version, 2);
  assert.equal(await store.commit(batch(1, 10, { source: parent })), "conflict");
});

test("invalid native call bindings leave the workspace owner and both sessions intact", async () => {
  const store = new InMemoryCollectorStorage();
  const call = { ...codexMeasurement("first", "call", 12), requestId: "one" };
  const claim = { providerId, usageId: call.id, ownerSessionId: parent.sessionId };
  assert.equal(await store.commit(batch(0, 0, { source: parent, usage: [call], codexCallClaims: [claim] })), "committed");
  const before = await store.readSession(parent);
  const alias = { ...call, id: "second" };
  for (const fields of [
    { codexCallClaims: [{ ...claim, providerId: "bad" }] },
    { codexCallClaims: [{ ...claim, providerId: "e".repeat(64) }] },
    { codexCallClaims: [{ ...claim, usageId: "unknown" }] },
    { codexCallClaims: [{ ...claim, ownerSessionId: child.sessionId }] },
    { usage: [alias], codexCallClaims: [{ ...claim, usageId: alias.id }] },
  ]) assert.equal(await store.commit(batch(1, 10, { source: parent, ...fields })), "invalid");
  assert.equal(await store.commit(batch(0, 0, { source: child, usage: [call], codexCallClaims: [claim] })), "invalid");
  assert.equal(await store.commit(batch(0, 0, { usage: [call], codexCallClaims: [claim] })), "invalid");
  assert.deepEqual(await store.readSession(parent), before);
  assert.equal((await store.readCheckpoint(parent)).version, 1);
  assert.deepEqual(await store.readCheckpoint(child), { version: 0, checkpoint: null });
});

test("a copied claim can name its verified parent before that parent has a session", async () => {
  const store = new InMemoryCollectorStorage();
  const claim = { providerId, usageId: "call:native:" + "f".repeat(64), ownerSessionId: parent.sessionId };
  assert.equal(await store.commit(batch(0, 0, { source: child, checkpoint: repaired, codexCallClaims: [claim] })), "committed");
  assert.equal(await store.readSession(parent), null);
  const call = { ...codexMeasurement("local", "call", 25), requestId: "one" };
  assert.equal(await store.commit(batch(0, 0, { source: parent, usage: [call], codexCallClaims: [{ ...claim, usageId: call.id }] })), "committed");
  assert.deepEqual((await store.readSession(parent))?.usage, [call]);
  assert.deepEqual((await store.readSession(child))?.usage, []);
});

test("a cyclic pair of parent links cannot establish an owner for a copied call", async () => {
  const store = new InMemoryCollectorStorage();
  const backward = { ...repaired, codexFork: { ...fork, parentSessionId: child.sessionId } };
  assert.equal(await store.commit(batch(0, 0, { source: parent, checkpoint: backward })), "committed");
  const copied = { providerId, usageId: "call:native:" + "f".repeat(64), ownerSessionId: parent.sessionId };
  assert.equal(await store.commit(batch(0, 0, { source: child, checkpoint: repaired, codexCallClaims: [copied] })), "invalid");
  assert.equal(await store.readSession(child), null);
});
