import assert from "node:assert/strict";
import { test } from "node:test";
import { ScanRejectedError } from "@tracerelic/collector/scan";
import { RejectedBatchFixture } from "../../fixtures/rejected-batch-fixture.ts";

test("a corrected batch resumes at A's accepted checkpoint and preserves B's accepted call", async t => {
  const fixture = await RejectedBatchFixture.create();
  t.after(() => fixture.close());
  const { original, checkpoint, byteRange } = await fixture.prepare("Original", 12);

  await assert.rejects(fixture.scan(), (error: unknown) => {
    assert(error instanceof ScanRejectedError);
    assert.deepEqual(error.rejections, [{ status: "rejected", source: fixture.a, byteRange }]);
    const diagnostics = error.message + JSON.stringify(error.rejections);
    for (const body of ["Original", fixture.changedText, "Private healthy reply"]) assert(!diagnostics.includes(body));
    return true;
  });
  assert.deepEqual(await fixture.storage.readSession(fixture.a), original);
  assert.deepEqual(await fixture.storage.readCheckpoint(fixture.a), checkpoint);
  const healthy = await fixture.storage.readSession(fixture.b);
  assert(healthy);
  assert.equal(healthy.usage.length, 1);
  assert.equal(healthy.observedTotalTokens, 12);
  const healthyCheckpoint = await fixture.storage.readCheckpoint(fixture.b);
  assert(healthyCheckpoint.checkpoint && healthyCheckpoint.version > 0);

  const endOffset = await fixture.repair(byteRange.startOffset);
  await fixture.scan();
  const repaired = await fixture.storage.readSession(fixture.a);
  assert(repaired);
  assert.deepEqual(repaired.messages[0], original.messages[0]);
  assert.deepEqual(repaired.messages.map(row => row.text), ["Original", fixture.changedText]);
  assert.equal(repaired.observedTotalTokens, 15);
  assert.equal(repaired.usage.length, 2);
  assert.deepEqual(repaired.usage.find(row => row.id === original.usage[0].id), original.usage[0]);
  assert.equal(repaired.metadata.branch, "later");
  const progress = await fixture.storage.readCheckpoint(fixture.a);
  assert.equal(progress.checkpoint?.offset, endOffset);
  assert.equal(progress.version, checkpoint.version + 1);
  await fixture.scan();
  assert.deepEqual(await fixture.storage.readSession(fixture.a), repaired);
  assert.deepEqual(await fixture.storage.readCheckpoint(fixture.a), progress);
  assert.deepEqual(await fixture.storage.readSession(fixture.b), healthy);
  assert.deepEqual(await fixture.storage.readCheckpoint(fixture.b), healthyCheckpoint);
});
