import assert from "node:assert/strict";
import { test } from "node:test";
import { ScanPendingError } from "#src/scan/scan-pending";
import { batch } from "../../fixtures/collector-storage-fixture.ts";
import { ScanRecoveryFixture } from "../../fixtures/scan-recovery-fixture.ts";

test("a newer session version alone permits a conflict retry but cannot confirm a timed-out write", async () => {
  const f = new ScanRecoveryFixture();
  const append = batch(1, 10);
  assert.deepEqual(await f.recovery.commit(append, f.saved, 10), f.winner);
  assert.equal(f.reads, 1);
  f.timeoutAfter(3, f.saved);
  await assert.rejects(f.recovery.commit({ ...append, expectedVersion: 2 }, f.saved, 10), (error: unknown) => {
    assert(error instanceof ScanPendingError);
    assert.equal(error.pending.reason, "storage-unavailable");
    return true;
  });
  assert.equal(f.reads, 2);
});

test("a lost upgrade reply can be confirmed at the same byte after a competing session update", async () => {
  const f = new ScanRecoveryFixture();
  const checkpoint = { ...f.saved, parserState: "upgraded" };
  const upgrade = batch(1, 10, { checkpoint, upgradeFromParserState: f.saved.parserState });
  assert.deepEqual(await f.recovery.commit(upgrade, f.saved, 0), f.winner);
  f.timeoutAfter(3, checkpoint);
  assert.deepEqual(await f.recovery.commit({ ...upgrade, expectedVersion: 2 }, f.saved, 0), f.winner);
  assert.deepEqual(f.verified, [[10], [10]]);
});

test("the winner's replay boundary must match the captured suffix", async () => {
  const f = new ScanRecoveryFixture();
  const append = batch(1, 10);
  f.winner.checkpoint = { ...f.saved, offset: 20, prefixDigest: "digest-20",
    replayThrough: { offset: 80, prefixDigest: "different-suffix" } };
  await assert.rejects(f.recovery.commit(append, f.saved, 10), ScanPendingError);
  assert.deepEqual(f.verified, [[20, 80]]);
});
