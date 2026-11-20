import assert from "node:assert/strict";
import { test } from "node:test";
import { ScanPendingError } from "#src/scan/scan-pending";
import { batch } from "../../fixtures/collector-storage-fixture.ts";
import { ScanRecoveryFixture } from "../../fixtures/scan-recovery-fixture.ts";

test("invalid returns the attempted cursor range without reading a winner or retrying", async () => {
  const f = new ScanRecoveryFixture();
  f.outcome = "invalid";
  const rewrite = batch(1, 10, { resetFrom: f.saved });
  assert.deepEqual(await f.recovery.commit(rewrite, f.saved, 0), {
    status: "rejected", source: rewrite.source, byteRange: { startOffset: 0, endOffset: 20 },
  });
  assert.equal(f.commits, 1);
  assert.equal(f.reads, 0);
  assert.deepEqual(f.verified, []);
});

test("a skipped prefix in an earlier copy stays pending when its first write is unconfirmed", async () => {
  const f = new ScanRecoveryFixture();
  const copy = batch(0, 0);
  f.outcome = "invalid";
  assert.deepEqual(await f.recovery.commit(copy, null, 5), {
    status: "rejected", source: copy.source, byteRange: { startOffset: 5, endOffset: 10 },
  });
  f.timeoutAfter(0, null);
  await assert.rejects(f.recovery.commit(copy, null, 5), (error: unknown) => {
    assert(error instanceof ScanPendingError);
    assert.deepEqual(error.pending.byteRange, { startOffset: 0, endOffset: 10 });
    return true;
  });
});

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

test("a lost reply to a same-byte fork correction can be confirmed from its saved evidence", async () => {
  const f = new ScanRecoveryFixture();
  const previous = { ...f.saved, codexFork: { parentSessionId: "parent", firstUncertain: { offset: 0, lineNumber: 1 } } };
  const next = { ...f.saved, codexFork: { parentSessionId: "parent", inheritedThrough: { offset: 10, lineNumber: 1 } } };
  f.timeoutAfter(2, next);
  const correction = batch(1, 10, { checkpoint: next, reconcileCodexForkFrom: previous });
  assert.deepEqual(await f.recovery.commit(correction, previous, 0), f.winner);
});

test("omitting empty optional checkpoint fields on the wire cannot confirm an unrelated write", async () => {
  const f = new ScanRecoveryFixture();
  const previous = { ...f.saved, replayThrough: undefined, codexFork: undefined };
  f.timeoutAfter(2, f.saved);
  await assert.rejects(f.recovery.commit(batch(1, 10), previous, 10), ScanPendingError);
});

test("a lost Claude origin backfill reply requires the origin marker on the durable checkpoint", async () => {
  const f = new ScanRecoveryFixture();
  const next = { ...f.saved, claudeCallOrigins: true as const };
  const correction = batch(1, 10, { checkpoint: next, backfillClaudeOriginsFrom: f.saved });
  f.timeoutAfter(2, next);
  assert.deepEqual(await f.recovery.commit(correction, f.saved, 0), f.winner);
  f.timeoutAfter(3, f.saved);
  await assert.rejects(f.recovery.commit({ ...correction, expectedVersion: 2 }, f.saved, 0), ScanPendingError);
});
