import assert from "node:assert/strict";
import { test } from "node:test";
import { ScanRejectedError } from "@tracerelic/collector/scan";
import { RejectedBatchFixture } from "#collector-fixture/rejected-batch-fixture";
import { CollectorApiFixture } from "../../fixtures/collector-api-fixture.ts";

test("an invalid upload preserves its source checkpoint while the other source syncs", async t => {
  const api = await CollectorApiFixture.open();
  t.after(() => api.close());
  const files = await RejectedBatchFixture.create(api.client);
  t.after(() => files.close());
  const before = await files.prepare("Original", 12);
  await assert.rejects(files.scan(), error => {
    assert(error instanceof ScanRejectedError);
    assert.deepEqual(error.rejections, [{ status: "rejected", source: files.a, byteRange: before.byteRange }]);
    return true;
  });
  assert.deepEqual(await api.a.readCheckpoint(files.a), before.checkpoint);
  assert.deepEqual(await api.a.readSession(files.a), before.original);
  assert.equal((await api.a.readSession(files.b))?.observedTotalTokens, 12);
});
