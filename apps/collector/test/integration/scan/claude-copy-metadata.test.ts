import assert from "node:assert/strict";
import { test } from "node:test";
import type { Batch } from "@tracerelic/collector/storage";
import { call, markedCopy, original } from "../../fixtures/claude-ownership-storage-fixture.ts";
import { ClaudeCopyMetadataFixture } from "../../fixtures/claude-copy-metadata-fixture.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";

for (const orphaned of [false, true]) {
  test(`repair retains the original metadata contributions of a Claude ${orphaned ? "orphaned" : "superseded"} file`, async t => {
    const files = await ClaudeCopyMetadataFixture.create(orphaned);
    t.after(() => files.close());
    const store = new InMemoryCollectorStorage();
    await files.seed(store);
    const before = await store.readSession(files.key);
    assert.deepEqual(before?.metadata, { cwd: "/current", repository: "first backup value", branch: "current-branch", parentSessionId: "current-parent" });
    const [repaired] = await files.scan(store);
    assert.deepEqual(repaired.metadata, before.metadata);
    assert.deepEqual(repaired.messages, before.messages);
    assert.deepEqual(await files.scan(store), [repaired]);
  });
}

test("repairing the backup cannot advance its observation beyond a later source", async t => {
  const files = await ClaudeCopyMetadataFixture.create();
  t.after(() => files.close());
  const store = new InMemoryCollectorStorage();
  const correctPeer = await files.seed(store, "after backup");
  await files.scan(store);
  assert.equal((await correctPeer(store, "later source"))?.metadata.repository, "later source");
});

test("a correction without a repeated source location uses the backup's acknowledged location", async t => {
  const files = await ClaudeCopyMetadataFixture.create();
  t.after(() => files.close());
  const store = new InMemoryCollectorStorage();
  await files.seed(store);
  const before = await store.readSession(files.key);
  const commit = store.commit.bind(store);
  t.mock.method(store, "commit", (batch: Batch) => {
    const { sourceObservation: _location, ...correction } = batch;
    return commit(batch.repairEvidenceFrom ? correction : batch);
  });
  assert.deepEqual(await files.scan(store), [before]);
});

test("a suppressed backup parent cannot remove a verified copied call from its native owner", async t => {
  const files = await ClaudeCopyMetadataFixture.create();
  t.after(() => files.close());
  const store = new InMemoryCollectorStorage();
  await files.seed(store);
  const parent = { ...files.key, sessionId: "current-parent", streamId: "original-call" };
  const child = { ...files.key, streamId: "copied-call" };
  const report = (tokens: number, origin: typeof original) => call("message-id", "request-id", tokens, origin);
  const fields = { expectedOffset: 0, checkpoint: { offset: 10, parserState: "{}" }, messages: [], usage: [] };
  assert.equal(await store.commit({ ...fields, source: parent, expectedVersion: 0,
    claudeUsageReports: [{ ...report(100, original), status: "provisional" }] }), "committed");
  const { version } = await store.readCheckpoint(child);
  assert.equal(await store.commit({ ...fields, source: child, expectedVersion: version,
    claudeUsageReports: [report(130, { ...markedCopy, parentSessionId: parent.sessionId })] }), "committed");
  const before = await store.readSession(parent);
  assert.equal(before?.observedTotalTokens, 130);
  const beforeChild = await store.readSession(child);
  await files.scan(store);
  assert.deepEqual(await store.readSession(parent), before);
  assert.deepEqual(await store.readSession(child), beforeChild);
  await files.appendCopyWithOrigin("backup-parent");
  await files.scan(store);
  assert.equal((await store.readSession(parent))?.observedTotalTokens, 100);
  const disputed = await store.readSession(child);
  assert(disputed?.usageDiagnostics?.some(row => row.code === "unresolved-claude-fork"));
});

for (const peer of ["before backup", "after backup"] as const) {
  test(`an equal repository from a different source keeps its original ownership (peer ${peer})`, async t => {
    const files = await ClaudeCopyMetadataFixture.create();
    t.after(() => files.close());
    const store = new InMemoryCollectorStorage();
    const withdraw = await files.seed(store, peer);
    assert.equal((await store.readSession(files.key))?.metadata.repository, "first backup value");
    await files.scan(store);
    const view = await withdraw(store);
    assert.equal(view?.metadata.repository, peer === "before backup" ? undefined : "first backup value");
  });
}

test("a Claude backup alias can be removed only when the surviving stream supplies its metadata", async () => {
  const root = "/home/claude";
  const path = "projects/work/chat.jsonl.superseded-2026";
  const source = { harness: "claude" as const, sessionId: "chat", installationId: "desktop", streamId: root + "/" + path };
  const fields = { expectedOffset: 0, checkpoint: { offset: 10, parserState: "{}", prefixDigest: "b".repeat(64) },
    sourceObservation: { location: { root, path }, observedEnd: 10 }, messages: [], usage: [] };
  const metadata = { repository: "accepted metadata" };
  for (const peerContributed of [false, true]) {
    const store = new InMemoryCollectorStorage();
    assert.equal(await store.commit({ ...fields, source, metadata, expectedVersion: 0 }), "committed");
    assert.equal(await store.commit({ ...fields, source: { ...source, streamId: path }, metadata: peerContributed ? metadata : {}, expectedVersion: 1 }), "committed");
    assert.equal(await store.mergeSourceAlias(source, path, 2), peerContributed);
    assert.deepEqual((await store.readSession(source))?.metadata, metadata);
  }
});
