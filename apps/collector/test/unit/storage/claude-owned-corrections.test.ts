import assert from "node:assert/strict";
import { test } from "node:test";
import { call, child, markedCopy, original, ownChild, parent } from "../../fixtures/claude-ownership-storage-fixture.ts";
import { batch, request } from "../../fixtures/collector-storage-fixture.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";

test("a final report from a verified copy updates the parent's measurement and version", async () => {
  const store = new InMemoryCollectorStorage();
  const provisional = { ...call("m", "original-request", 100, original), status: "provisional" as const };
  const old = batch(0, 0, { source: parent, claudeUsageReports: [provisional] });
  assert.equal(await store.commit(old), "committed");
  const before = await store.readSession(parent);
  assert(before);
  const [accepted] = before.usage;

  const final = { ...call("m", "fork-request", 80, markedCopy), at: "2026-02-01T12:00:01Z" };
  const own = call("child-m", "child-r", 25, ownChild);
  const fromChild = batch(0, 0, { source: child, claudeUsageReports: [final, own], metadata: { parentSessionId: parent.sessionId } });
  assert.equal(await store.commit(fromChild), "committed");
  const corrected = await store.readSession(parent);
  assert.equal(corrected?.observedTotalTokens, 80);
  assert.deepEqual(corrected.usage, [{ ...accepted, inputTokens: 80, status: "final", revision: accepted.revision + 1 }]);
  assert.deepEqual(await store.readCheckpoint(parent), { version: 2, checkpoint: old.checkpoint });
  assert.equal((await store.readSession(child))?.observedTotalTokens, 25);

  const repeated = batch(1, 10, { source: child, claudeUsageReports: [final, own] });
  assert.equal(await store.commit(repeated), "committed");
  assert.deepEqual(await store.readSession(parent), corrected);
  assert.equal((await store.readCheckpoint(parent)).version, 2);
  assert.equal(await store.commit(batch(1, 10, { source: parent, claudeUsageReports: [provisional] })), "conflict");
  assert.equal(await store.commit(batch(2, 10, { source: parent, claudeUsageReports: [provisional] })), "committed");
  assert.deepEqual(await store.readSession(parent), corrected);
});

test("two conflicting final reports in verified copies withdraw the parent's call and leave its independent usage", async () => {
  const store = new InMemoryCollectorStorage();
  const provisional = { ...call("m", "r", 100, original), status: "provisional" as const };
  const independent = request({ id: "direct", inputTokens: 11, outputTokens: 0 });
  assert.equal(await store.commit(batch(0, 0, { source: parent, usage: [independent], claudeUsageReports: [provisional] })), "committed");
  const reported = call("m", "r", 80, markedCopy);
  assert.equal(await store.commit(batch(0, 0, { source: child, claudeUsageReports: [reported] })), "committed");
  assert.equal((await store.readSession(parent))?.observedTotalTokens, 91);
  const other = { ...child, sessionId: "sibling", installationId: "third" };
  assert.equal(await store.commit(batch(0, 0, { source: other, claudeUsageReports: [{ ...reported, inputTokens: 81 }] })), "committed");
  const disputed = await store.readSession(parent);
  assert.deepEqual(disputed?.usage, [independent]);
  assert.equal(disputed.coverage, "partial");
  assert.equal((await store.readCheckpoint(parent)).version, 3);
  for (const owner of [child, other]) {
    const copy = await store.readSession(owner);
    assert.equal(copy?.observedTotalTokens, null);
    assert.equal(copy.usageDiagnostics, undefined);
  }
  assert.equal(await store.commit(batch(1, 10, { source: child, claudeUsageReports: [reported] })), "committed");
  assert.deepEqual(await store.readSession(parent), disputed);
  assert.equal((await store.readCheckpoint(parent)).version, 3);
});

test("a final from a verified copy can restore a disputed provisional parent measurement in its original slot", async () => {
  const store = new InMemoryCollectorStorage();
  const partial = { ...call("m", "r", 100, original), outputTokens: 1, status: "provisional" as const };
  const direct = request({ id: "older", inputTokens: 1, outputTokens: 0 });
  assert.equal(await store.commit(batch(0, 0, { source: parent, usage: [direct], claudeUsageReports: [partial] })), "committed");
  const before = await store.readSession(parent);
  assert(before);
  const [first, previous] = before.usage;
  assert.equal(await store.commit(batch(1, 10, { source: parent, claudeUsageReports: [{ ...partial, inputTokens: 95, outputTokens: 4 }] })), "committed");
  assert.deepEqual((await store.readSession(parent))?.usage, [first]);
  const final = call("m", "fork-r", 80, markedCopy);
  assert.equal(await store.commit(batch(0, 0, { source: child, claudeUsageReports: [final] })), "committed");
  const restored = await store.readSession(parent);
  assert.deepEqual(restored?.usage, [first, { ...previous, status: "final", inputTokens: 80, outputTokens: 0, revision: previous.revision + 1 }]);
  assert.equal(restored.coverage, "partial");
  const copy = await store.readSession(child);
  assert.equal(copy?.observedTotalTokens, null);
  assert.equal(copy.usageDiagnostics, undefined);
});

test("a copied correction that would overflow its owner's total rolls back the entire child write", async () => {
  const store = new InMemoryCollectorStorage();
  const small = { ...call("m", "r", 1, original), status: "provisional" as const };
  const direct = request({ id: "ordinary", inputTokens: Number.MAX_SAFE_INTEGER - 1, outputTokens: 0 });
  const before = batch(0, 0, { source: parent, usage: [direct], claudeUsageReports: [small] });
  assert.equal(await store.commit(before), "committed");
  const view = await store.readSession(parent);
  const huge = call("m", "r", 2, markedCopy);
  const correction = batch(0, 0, { source: child, claudeUsageReports: [huge, call("child", "own", 15, ownChild)] });
  assert.equal(await store.commit(correction), "invalid");
  assert.equal(await store.readSession(child), null);
  assert.deepEqual(await store.readSession(parent), view);
  assert.deepEqual(await store.readCheckpoint(parent), { version: 1, checkpoint: before.checkpoint });
});

test("a later parent completion preserves a numerical gap previously established by the same confirmed reports", async () => {
  const store = new InMemoryCollectorStorage();
  const partial = { ...call("m", "r", 100, original), outputTokens: 1, status: "provisional" as const };
  assert.equal(await store.commit(batch(0, 0, { source: parent, claudeUsageReports: [partial] })), "committed");
  const crossing = { ...call("m", "r", 95, markedCopy), outputTokens: 4, status: "provisional" as const };
  assert.equal(await store.commit(batch(0, 0, { source: child, claudeUsageReports: [crossing] })), "committed");
  assert.equal((await store.readSession(parent))?.observedTotalTokens, null);
  const final = call("m", "r", 80, original);
  assert.equal(await store.commit(batch(2, 10, { source: parent, claudeUsageReports: [final] })), "committed");
  const resolved = await store.readSession(parent);
  assert.equal(resolved?.observedTotalTokens, 80);
  assert.equal(resolved.coverage, "partial");
});

test("a direct record cannot overwrite a native slot established after separating a forked partial request", async () => {
  const store = new InMemoryCollectorStorage();
  assert.equal(await store.commit(batch(0, 0, { source: parent, claudeUsageReports: [call("m", "r", 100, original)] })), "committed");
  const copy = { ...call("m", "r", 100, markedCopy), requestId: undefined };
  const own = call("m", "different", 25, ownChild);
  const first = batch(0, 0, { source: child, claudeUsageReports: [copy, own] });
  assert.equal(await store.commit(first), "committed");
  const before = await store.readSession(child);
  assert.equal(before?.observedTotalTokens, 25);
  const direct = batch(1, 10, { source: child, usage: [request({ id: before.usage[0].id, inputTokens: 900 })] });
  assert.equal(await store.commit(direct), "invalid");
  assert.deepEqual(await store.readSession(child), before);
  assert.deepEqual(await store.readCheckpoint(child), { version: 1, checkpoint: first.checkpoint });
});
