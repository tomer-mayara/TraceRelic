import assert from "node:assert/strict";
import { test } from "node:test";
import { DroppedConnection } from "../../fixtures/lost-connection-fixture.ts";
import { ScanCommandFixture } from "../../fixtures/scan-command-fixture.ts";
import { ScheduledScanFixture } from "../../fixtures/scheduled-scan-fixture.ts";

test("a recovered source stops aging when a later source loses its checkpoint read", async t => {
  const files = await ScanCommandFixture.create();
  t.after(() => files.close());
  await files.configure();
  await files.writePlanningChat();
  await files.scan();
  await files.writeRepeatedClaudePrompt("A new planning chat");
  const storage = files.storage;
  const read = storage.readCheckpoint.bind(storage);
  let unavailable: string = files.codexKey.sessionId;
  t.mock.method(storage, "readCheckpoint", (source: Parameters<typeof read>[0]) => {
    if (source.sessionId === unavailable) throw Object.assign(new Error("Disconnected"), { code: "ECONNRESET" });
    return read(source);
  });
  t.mock.method(console, "error", () => {});
  const watch = new ScheduledScanFixture(storage, ["--config", files.configFile]);
  try {
    await watch.waitForPass();
    assert.equal(watch.reports[0].status, "pending");
    unavailable = files.claudeKey.sessionId;
    await watch.advance(1000);
    assert.equal(watch.reports[1].status, "pending");
    assert.equal(watch.reports[1].oldestPendingAgeMs, 0);
    await watch.advance(1000);
    assert.equal(watch.reports[2].oldestPendingAgeMs, 1000);
  } finally {
    await watch.stop();
  }
});

for (const moment of ["before storage writes", "after storage writes"] as const) {
  test(`watch confirms a new session once when the first connection drops ${moment}`, async t => {
    const fixture = await ScanCommandFixture.create();
    t.after(() => fixture.close());
    await fixture.configure();
    await fixture.writePlanningChat();
    const connection = new DroppedConnection(fixture.storage);
    connection.dropNextWrite(moment);
    const diagnostics = t.mock.method(console, "error", () => {});
    const watch = new ScheduledScanFixture(connection, ["--config", fixture.configFile], { intervalMs: 100, startMs: Date.UTC(2026, 0, 1) });
    const { clock, reports } = watch;
    let exitCode: number;
    try {
      await watch.waitForPass();
      for (const age of [0, 1000]) {
        assert.deepEqual(reports.at(-1), { status: "pending", newSessions: 0, oldestPendingAgeMs: age,
          retryAt: new Date(clock.now() + 1000).toISOString() });
        if (age === 1000) connection.reconnect();
        await watch.advance(1000);
      }
      assert.deepEqual(reports[2], { status: "complete", newSessions: 1, oldestPendingAgeMs: null });
      assert.deepEqual((await fixture.storage.readSession(fixture.codexKey))?.messages.map(row => row.text),
        fixture.codexMessages.map(row => row.text));
      await watch.advance();
      assert.deepEqual(reports[3], { status: "complete", newSessions: 0, oldestPendingAgeMs: null });
      assert.equal(reports.length, 4);
      assert.equal(connection.writes, moment === "before storage writes" ? 2 : 1);
      assert.equal(diagnostics.mock.callCount(), 2);
    } finally {
      exitCode = await watch.stop();
    }
    assert.equal(exitCode, 0);
  });
}
