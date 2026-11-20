import assert from "node:assert/strict";
import { test } from "node:test";
import { ScanPendingError } from "#src/scan/scan-pending";
import { source } from "../../fixtures/collector-storage-fixture.ts";

test("reports only the attempted source, byte range, reason and next retry time", t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T00:00:00Z") });
  const attempted = { ...source, installationId: "local", transcript: "private transcript" };
  const range = { startOffset: 34, endOffset: 56, content: "private transcript" };
  const error = new ScanPendingError("storage-unavailable", attempted, range);
  assert.deepEqual(error.pending, {
    status: "pending", reason: "storage-unavailable", source: { ...source, installationId: "local" },
    byteRange: { startOffset: 34, endOffset: 56 }, retryAt: "2026-01-01T00:00:01.000Z",
  });
  assert.doesNotMatch(error.message, /private transcript/);
  t.mock.timers.tick(1000);
  assert.equal(Date.now(), Date.parse(error.pending.retryAt));
});

test("reports a conflict without a byte range when no batch is available", t => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-02T09:00:00Z") });
  const error = new ScanPendingError("version-conflict", source);
  assert.match(error.message, /Storage returned conflict/);
  assert.deepEqual(error.pending, {
    status: "pending", reason: "version-conflict", source, retryAt: "2026-01-02T09:00:01.000Z",
  });
});
