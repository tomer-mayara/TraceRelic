import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Batch, StreamKey } from "@tracerelic/collector/storage";
import { ClaudeForkScanFixture } from "../../fixtures/claude-fork-scan-fixture.ts";
import { ScanCommandFixture } from "../../fixtures/scan-command-fixture.ts";

for (const replay of [false, true]) {
  test(`backfills a Claude ${replay ? "replay" : "version 2"} checkpoint once without changing its accepted chat or calls`, async t => {
    const f = await ScanCommandFixture.create();
    t.after(() => f.close());
    await f.configure();
    await f.writeClaudeRequest(40, 2, 91);
    const commit = f.storage.commit.bind(f.storage);
    let key: StreamKey | undefined;
    const legacy = t.mock.method(f.storage, "commit", (batch: Batch) => {
      key = batch.source;
      const { offset, prefixDigest, parserState } = batch.checkpoint;
      const earlierState = replay ? JSON.stringify({ ...JSON.parse(parserState), version: 3,
        replayOccurrences: { ["c".repeat(64)]: { accepted: 2, replayed: 1 } } }) : parserState;
      return commit({ ...batch, checkpoint: { offset, prefixDigest, parserState: earlierState },
        claudeUsageReports: batch.claudeUsageReports?.map(({ origin: _origin, ...report }) => report) });
    });
    const initial = await f.scan();
    legacy.mock.restore();
    assert(key);
    const before = await f.storage.readCheckpoint(key);
    assert(before.checkpoint);
    f.restart();
    const writes = t.mock.method(f.storage, "commit", commit);
    assert.deepEqual(await f.scan(), initial);
    assert.equal(writes.mock.calls.length, 1);
    const [correction] = writes.mock.calls[0].arguments;
    assert.deepEqual(correction.repairEvidenceFrom, before.checkpoint);
    assert.deepEqual(correction.claudeUsageReports?.map(row => row.origin?.transcriptUuid), ["claude-first", "claude-second"]);
    assert.deepEqual(await f.storage.readCheckpoint(key), {
      version: before.version + 1, checkpoint: { ...before.checkpoint, claudeCallOrigins: true, evidenceVersion: 1 },
    });
    assert.deepEqual(await f.scan(), initial);
    assert.equal(writes.mock.calls.length, 1);
  });
}

test("a workspace with older Claude reports can correct the fork at both accepted bytes", async t => {
  const f = await ClaudeForkScanFixture.create("fork");
  t.after(() => f.close());
  await f.writeParent();
  await f.writeCopy();
  await f.appendOwn();
  const commit = f.storage.commit.bind(f.storage);
  const oldWriter = t.mock.method(f.storage, "commit", (batch: Batch) => {
    const { offset, prefixDigest, parserState } = batch.checkpoint;
    return commit({ ...batch, metadata: {}, checkpoint: { offset, prefixDigest, parserState },
      claudeUsageReports: batch.claudeUsageReports?.map(({ origin: _origin, ...report }) => report) });
  });
  await f.scan("child");
  await f.scan("parent");
  oldWriter.mock.restore();
  const before = await f.snapshot();
  assert.equal(before.child.observedTotalTokens, 125);
  assert.equal(before.parent.observedTotalTokens, 100);

  await f.scan("child");
  await f.scan("parent");
  const after = await f.snapshot();
  assert.equal(after.child.observedTotalTokens, 25);
  assert.equal(after.child.coverage, "reported");
  assert.equal(after.child.metadata.parentSessionId, "parent");
  assert.deepEqual(after.child.messages, before.child.messages);
  assert.deepEqual(after.parent, before.parent);
  for (const key of ["childCheckpoint", "parentCheckpoint"] as const) {
    assert.deepEqual(after[key].checkpoint, { ...before[key].checkpoint, claudeCallOrigins: true, evidenceVersion: 1 });
    assert(after[key].version > before[key].version);
  }
  await f.scan("parent");
  await f.scan("child");
  assert.deepEqual(await f.snapshot(), after);
});

test("a previously reset Claude source can start collecting call origins from byte zero", async t => {
  const f = await ScanCommandFixture.create();
  t.after(() => f.close());
  await f.configure();
  await f.writeClaudeRequest(40, 2, 91);
  const commit = f.storage.commit.bind(f.storage);
  let key: StreamKey | undefined;
  const observe = t.mock.method(f.storage, "commit", (batch: Batch) => { key = batch.source; return commit(batch); });
  const initial = await f.scan();
  observe.mock.restore();
  assert(key);
  const before = await f.storage.readCheckpoint(key);
  assert(before.checkpoint);
  const empty = { offset: 0, prefixDigest: createHash("sha256").digest("hex"), parserState: "{}" };
  assert.equal(await commit({ source: key, expectedVersion: before.version, expectedOffset: before.checkpoint.offset,
    resetFrom: before.checkpoint, checkpoint: empty, messages: [], usage: [] }), "committed");
  assert.deepEqual(await f.scan(), initial);
  assert.deepEqual((await f.storage.readCheckpoint(key)).checkpoint, before.checkpoint);
});

test("a text-only fork checkpoint recovers its parent link from a copied user row", async t => {
  const f = await ClaudeForkScanFixture.create("fork");
  t.after(() => f.close());
  await f.roots.child.write("project", f.child.sessionId, [{
    sessionId: f.child.sessionId, type: "user", uuid: "remapped-prompt", timestamp: "2026-02-01T12:01:00Z",
    forkedFrom: { sessionId: f.parent.sessionId, messageUuid: "original-prompt" }, message: { role: "user", content: "Plan" },
  }]);
  const commit = f.storage.commit.bind(f.storage);
  const legacy = t.mock.method(f.storage, "commit", (batch: Batch) => {
    const { offset, prefixDigest, parserState } = batch.checkpoint;
    return commit({ ...batch, metadata: {}, checkpoint: {
      offset, prefixDigest, parserState: JSON.stringify({ ...JSON.parse(parserState), version: 1 }),
    } });
  });
  await f.scan("child");
  legacy.mock.restore();
  const before = await f.storage.readSession(f.child);
  assert(before);
  assert.deepEqual(before.metadata, {});
  await f.scan("child");
  assert.deepEqual(await f.storage.readSession(f.child), { ...before, metadata: { parentSessionId: f.parent.sessionId } });
  assert.equal((await f.storage.readCheckpoint(f.child)).checkpoint?.claudeCallOrigins, true);
});
