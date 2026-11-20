import assert from "node:assert/strict";
import { rm, stat } from "node:fs/promises";
import { test } from "node:test";
import { GlobalConfig } from "@tracerelic/collector/config";
import { LocalCollector, ScanPendingError } from "@tracerelic/collector/scan";
import { StorageBackoffError, type MissingSource } from "@tracerelic/collector/storage";
import { CodexRolloutFixture as Rollout } from "../../fixtures/codex-rollout-fixture.ts";
import { PresenceConnection } from "../../fixtures/presence-connection.ts";
import { ScanCommandFixture } from "../../fixtures/scan-command-fixture.ts";
import { ScheduledScanFixture } from "../../fixtures/scheduled-scan-fixture.ts";

test("watch defers an inventory read until its server deadline even across regular ticks", async t => {
  const files = await ScanCommandFixture.create();
  t.after(() => files.close());
  await files.configure();
  const list = t.mock.method(files.storage, "listSources");
  list.mock.mockImplementationOnce(() => { throw new StorageBackoffError(4000); });
  const diagnostic = t.mock.method(console, "error", () => {});
  const watch = new ScheduledScanFixture(files.storage, ["--config", files.configFile], { startMs: 0, intervalMs: 100 });
  try {
    await watch.waitForPass();
    assert.deepEqual(watch.reports, [{ status: "pending", retryAt: "1970-01-01T00:00:04.000Z", newSessions: 0, oldestPendingAgeMs: 0 }]);
    const pending = JSON.parse(diagnostic.mock.calls[0].arguments[0]);
    assert.equal(pending.scope.harness, "codex");
    assert.equal(pending.retryAt, watch.reports[0].retryAt);
    await watch.advance(3999);
    assert.equal(list.mock.callCount(), 1);
    await watch.advance(1);
    assert.deepEqual(watch.reports[1], { status: "complete", newSessions: 0, oldestPendingAgeMs: null });
  } finally {
    await watch.stop();
  }
});

for (const moment of ["before", "after"] as const) {
  test(`a delay ${moment} storage records a disappearance defers its confirmation until the next pass`, async t => {
    t.mock.timers.enable({ apis: ["Date"], now: 0 });
    const root = await Rollout.create();
    t.after(() => root.close());
    const file = await root.write([Rollout.header("work")]);
    const storage = new PresenceConnection();
    const reports: MissingSource[] = [];
    const scanner = new LocalCollector(new GlobalConfig(root.home), storage, undefined, report => reports.push(report));
    await scanner.scanOnce();
    const end = (await stat(file)).size;
    await rm(file);
    const inventory = t.mock.method(storage, "listSources");
    const write = storage.recordPresence.bind(storage);
    const presence = t.mock.method(storage, "recordPresence");
    presence.mock.mockImplementationOnce(async update => {
      if (moment === "after") await write(update);
      throw new StorageBackoffError(8000);
    });
    await assert.rejects(scanner.scanOnce(), (error: unknown) => {
      assert(error instanceof ScanPendingError);
      assert.equal(error.pending.source?.sessionId, "work");
      assert.equal(error.pending.retryAt, "1970-01-01T00:00:08.000Z");
      return true;
    });
    assert.equal(inventory.mock.callCount(), 1);
    assert.equal(reports.length, 0);
    const [session] = await scanner.scanOnce();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].acceptedOffset, end);
    assert.deepEqual(session.missingSources, reports);
  });
}
