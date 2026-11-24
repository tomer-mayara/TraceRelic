import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { test } from "node:test";
import { ScanPendingError } from "@tracerelic/collector/scan";
import type { Batch } from "@tracerelic/collector/storage";
import { textOnlyBatch } from "../../fixtures/collector-storage-fixture.ts";
import { RewriteScanFixture } from "../../fixtures/rewrite-scan-fixture.ts";

test("a timed-out reset reports the attempted replacement bytes and preserves the old checkpoint", async t => {
  const fixture = await RewriteScanFixture.create();
  t.after(() => fixture.close());
  await fixture.write([fixture.call("original", 120)], 4096);
  await fixture.scan();
  const before = await fixture.storage.readCheckpoint(fixture.source);
  await fixture.write([fixture.call("replacement", 30)]);
  const end = (await stat(fixture.file)).size;
  const read = t.mock.method(fixture.storage, "readCheckpoint");
  const write = t.mock.method(fixture.storage, "commit", async () => {
    throw Object.assign(new Error("Write timed out"), { code: "ETIMEDOUT" });
  });
  await assert.rejects(fixture.scan(), (error: unknown) => {
    assert(error instanceof ScanPendingError);
    assert.partialDeepStrictEqual(error.pending, {
      reason: "storage-unavailable", source: fixture.source, byteRange: { startOffset: 0, endOffset: end },
    });
    return true;
  });
  assert.equal(write.mock.callCount(), 1);
  assert.equal(read.mock.callCount(), 2);
  assert.deepEqual(await fixture.storage.readCheckpoint(fixture.source), before);
});

test("a version change on a different source preserves the intended reset of this source", async t => {
  const fixture = await RewriteScanFixture.create();
  t.after(() => fixture.close());
  await fixture.write([fixture.call("original", 120)], 4096);
  await fixture.scan();
  const before = await fixture.storage.readCheckpoint(fixture.source);
  await fixture.write([fixture.call("replacement", 30)]);
  const commit = fixture.storage.commit.bind(fixture.storage);
  let attempts = 0;
  t.mock.method(fixture.storage, "commit", async (batch: Batch) => {
    assert.deepEqual(batch.resetFrom, before.checkpoint);
    if (++attempts === 1) {
      assert.equal(await commit({
        source: { ...fixture.source, installationId: "other" }, expectedVersion: before.version,
        expectedOffset: 0, checkpoint: { offset: 10, parserState: "{}" }, messages: [], usage: [],
      }), "committed");
    }
    return commit(batch);
  });
  assert.equal((await fixture.scan()).observedTotalTokens, 150);
  assert.equal(attempts, 2);
});

test("a timed-out backfill with an append reports the entire attempted prefix", async t => {
  const fixture = await RewriteScanFixture.create();
  t.after(() => fixture.close());
  await fixture.write([fixture.call("first", 120)]);
  const commit = fixture.storage.commit.bind(fixture.storage);
  const legacy = t.mock.method(fixture.storage, "commit", (batch: Batch) =>
    commit(textOnlyBatch(batch, { ...batch.checkpoint, parserState: "{}" })));
  await fixture.scan();
  legacy.mock.restore();
  await fixture.append(fixture.call("second", 30));
  const end = (await stat(fixture.file)).size;
  t.mock.method(fixture.storage, "commit", async () => {
    throw Object.assign(new Error("Write timed out"), { code: "ETIMEDOUT" });
  });
  await assert.rejects(fixture.scan(), (error: unknown) => {
    assert(error instanceof ScanPendingError);
    assert.deepEqual(error.pending.byteRange, { startOffset: 0, endOffset: end });
    return true;
  });
});
