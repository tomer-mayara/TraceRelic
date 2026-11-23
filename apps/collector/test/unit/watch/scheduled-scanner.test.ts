import assert from "node:assert/strict";
import { test } from "node:test";
import { ScanPendingError } from "#src/scan/scan-pending";
import { ScanRejectedError, rejectedBatch } from "#src/scan/scan-rejected";
import { ScheduledScanner } from "#src/watch/scheduled-scanner";
import { StorageAuthenticationError } from "#src/storage/collector-storage";
import { source } from "../../fixtures/collector-storage-fixture.ts";
import { ScheduledScannerFixture } from "../../fixtures/scheduled-scanner-fixture.ts";

test("a rejected credential reports the failed pass and stops scheduling", async t => {
  const f = new ScheduledScannerFixture();
  const rejected = new StorageAuthenticationError();
  f.work = async () => { throw rejected; };
  const wait = t.mock.method(f.clock, "wait", async () => { throw new Error("Watch tried to schedule another scan"); });
  await assert.rejects(f.run(), error => error === rejected);
  assert.deepEqual(f.reports, [{ status: "failed", newSessions: 0, oldestPendingAgeMs: null }]);
  assert.equal(wait.mock.callCount(), 0);
});

test("starts immediately and runs one scan per interval until stopped", async () => {
  const f = new ScheduledScannerFixture();
  const done = f.run();
  await f.clock.whenWaiting();
  assert.deepEqual(f.starts, [0]);
  f.clock.advance(99);
  assert.deepEqual(f.starts, [0]);
  f.clock.advance(1);
  await f.clock.whenWaiting();
  f.controller.abort();
  await done;
  f.clock.advance(200);
  assert.deepEqual(f.starts, [0, 100]);
  assert.equal(f.passes, 2);
  assert.deepEqual(f.reports.map(report => report.status), ["complete", "complete"]);
});

test("a slow scan skips elapsed ticks and excludes another run on the same collector", async () => {
  const f = new ScheduledScannerFixture();
  let finish!: () => void;
  f.work = () => new Promise<void>(resolve => { finish = resolve; });
  const done = f.run();
  f.clock.advance(250);
  await assert.rejects(f.run(), /already running/);
  assert.deepEqual(f.starts, [0]);
  finish();
  await f.clock.whenWaiting();
  f.clock.advance(49);
  assert.deepEqual(f.starts, [0]);
  f.work = async () => {};
  f.clock.advance(1);
  await f.clock.whenWaiting();
  f.controller.abort();
  await done;
  assert.deepEqual(f.starts, [0, 300]);
});

test("shutdown waits for the active scan and reports its result before resolving", async () => {
  const f = new ScheduledScannerFixture();
  let finish!: () => void;
  f.work = () => new Promise<void>(resolve => { finish = resolve; });
  let stopped = false;
  const done = f.run().then(() => { stopped = true; });
  f.controller.abort();
  f.clock.advance(1_000);
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.equal(f.reports.length, 0);
  finish();
  await done;
  assert.deepEqual(f.starts, [0]);
  assert.equal(f.reports[0].status, "complete");
});

test("a signal already aborted at startup prevents the first scan", async () => {
  const f = new ScheduledScannerFixture();
  f.controller.abort();
  await f.run();
  assert.deepEqual(f.starts, []);
  assert.deepEqual(f.reports, []);
});

test("an invalid interval is rejected before a direct caller can start a scan", async () => {
  const f = new ScheduledScannerFixture();
  f.work = async () => { f.controller.abort(); };
  for (const value of [0, -1, 1.5, 2_147_483_648, Infinity, NaN]) {
    await assert.rejects(f.run(value), /--interval-ms.*1.*2147483647/);
  }
  assert.deepEqual(f.starts, []);
});

for (const interval of [300, 60_000]) {
  test(`retries at the pending deadline with a ${interval} ms regular interval`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    const f = new ScheduledScannerFixture();
    const error = new ScanPendingError("version-conflict", source);
    f.work = async () => { throw error; };
    const done = f.run(interval);
    await f.clock.whenWaiting();
    assert.deepEqual(f.pending, [error.pending]);
    assert.deepEqual(f.pendingDiagnostics, [error.pending]);
    assert.equal(f.reports[0].retryAt, "1970-01-01T00:00:01.000Z");
    f.work = async () => {};
    f.clock.advance(999);
    assert.deepEqual(f.starts, [0]);
    f.clock.advance(1);
    await f.clock.whenWaiting();
    const next = interval * Math.ceil(1000 / interval);
    f.clock.advance(next - 1000);
    await f.clock.whenWaiting();
    f.controller.abort();
    await done;
    assert.deepEqual(f.starts, [0, 1000, next]);
    assert.deepEqual(f.reports.map(report => report.status), ["pending", "complete", "complete"]);
  });
}

test("a pending deadline that elapsed during a scan waits for the next regular tick", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const f = new ScheduledScannerFixture();
  const error = new ScanPendingError("storage-unavailable", source);
  f.work = async () => {
    f.clock.advance(1_500);
    throw error;
  };
  const done = f.run(2_000);
  await f.clock.whenWaiting();
  f.work = async () => {};
  f.clock.advance(499);
  assert.deepEqual(f.starts, [0]);
  f.clock.advance(1);
  await f.clock.whenWaiting();
  f.controller.abort();
  await done;
  assert.deepEqual(f.starts, [0, 2000]);
});

test("rejected and failed passes report their outcome and retry on regular ticks", async () => {
  const f = new ScheduledScannerFixture();
  const rejection = rejectedBatch(source, { startOffset: 1, endOffset: 3 });
  const failure = new Error("private transcript text");
  f.work = async () => { throw new ScanRejectedError([], [rejection]); };
  const done = f.run();
  await f.clock.whenWaiting();
  f.work = async () => { throw failure; };
  f.clock.advance(100);
  await f.clock.whenWaiting();
  assert.deepEqual(f.failures, [failure]);
  f.work = async () => {};
  f.clock.advance(100);
  await f.clock.whenWaiting();
  f.controller.abort();
  await done;
  assert.deepEqual(f.starts, [0, 100, 200]);
  assert.deepEqual(f.reports.map(report => report.status), ["rejected", "failed", "complete"]);
  assert.doesNotMatch(JSON.stringify(f.reports), /private transcript|retryAt/);
});

test("aborting the production clock releases a long interval", async () => {
  const f = new ScheduledScannerFixture();
  const scanner = new ScheduledScanner(async () => {}, f.activity);
  await scanner.run({
    intervalMs: 2_147_483_647, signal: f.controller.signal,
    onReport: () => queueMicrotask(() => f.controller.abort()),
  });
  assert.equal(f.passes, 1);
});
