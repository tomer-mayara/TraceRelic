import assert from "node:assert/strict";
import { test } from "node:test";
import { runCollectorCli } from "#src/cli";
import { captureCollectorCli } from "../../fixtures/capture-collector-cli.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";
import { LocalCollectorCliFixture } from "../../fixtures/local-collector-cli-fixture.ts";

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`watch prints a startup report and exits cleanly on ${signal}`, async t => {
    const fixture = await LocalCollectorCliFixture.create();
    t.after(() => fixture.close());
    const config = await fixture.writeConfig("..");
    await fixture.writeChat(fixture.configured, "private-planning-chat");
    const result = await fixture.watchThroughSignal(config, signal);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.exitSignal, null);
    assert.equal(result.stderr, "");
    assert.deepEqual(result.stdout.map(line => JSON.parse(line)), [
      { status: "complete", newSessions: 1, oldestPendingAgeMs: null },
    ]);
  });
}

test("watch uses the default interval and accepts both interval limits", async t => {
  const fixture = await LocalCollectorCliFixture.create();
  t.after(() => fixture.close());
  const config = await fixture.writeConfig("..");
  for (const [args, expected] of [[[], 60_000], [["--interval-ms", "1"], 1],
    [["--interval-ms", "2147483647"], 2_147_483_647]] as const) {
    const stop = new AbortController();
    const waits: number[] = [];
    const clock = { now: () => 0, wait: async (ms: number) => { waits.push(ms); stop.abort(); } };
    const report = t.mock.fn();
    const code = await runCollectorCli(["watch", "--config", config, ...args], new InMemoryCollectorStorage(),
      { signal: stop.signal, clock, onReport: report });
    assert.equal(code, 0);
    assert.deepEqual(waits, [expected]);
    assert.equal(report.mock.callCount(), 1);
  }
});

test("watch validates its interval, selection and incompatible flags before opening the config", async t => {
  const config = ["--config", "missing-config.json"];
  const storage = new InMemoryCollectorStorage();
  for (const value of ["0", "-1", "1.5", "1e3", "2147483648", ""]) {
    const result = await captureCollectorCli(t, ["watch", ...config, "--interval-ms=" + value], storage);
    assert.equal(result.code, 1);
    assert.deepEqual(result.stdout, []);
    assert.match(result.stderr[0], /interval-ms.*1.*2147483647/);
  }
  for (const [command, ...options] of [["watch", "--from", "today"], ["watch", "--to", "today"], ["watch", "--once"],
    ["scan", "--once", "--interval-ms", "1"], ["history", "--interval-ms", "1"]]) {
    const result = await captureCollectorCli(t, [command, ...config, ...options], storage);
    assert.equal(result.code, 1);
    assert.match(result.stderr[0], /Usage:/);
  }
  const result = await captureCollectorCli(t, ["watch", ...config, "--session", "  "], storage);
  assert.equal(result.code, 1);
  assert.match(result.stderr[0], /nonblank session ID or project directory/);
});

test("watch releases its signal handlers when its configuration cannot be opened", async t => {
  const listeners = () => [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const before = listeners();
  const result = await captureCollectorCli(t, ["watch", "--config", "missing-config.json"], new InMemoryCollectorStorage());
  assert.equal(result.code, 1);
  assert.match(result.stderr[0], /Cannot read configuration file/);
  assert.deepEqual(listeners(), before);
});

test("watch writes a sanitized diagnostic for an unexpected scan failure", async t => {
  const fixture = await LocalCollectorCliFixture.create();
  t.after(() => fixture.close());
  const config = await fixture.writeConfig("..");
  const storage = new InMemoryCollectorStorage();
  t.mock.method(storage, "listSources", async () => { throw new Error("private transcript detail"); });
  const stderr = t.mock.method(console, "error", () => {});
  const stop = new AbortController();
  const reports: unknown[] = [];
  const code = await runCollectorCli(["watch", "--config", config], storage, {
    signal: stop.signal, onReport: report => { reports.push(report); stop.abort(); },
  });
  assert.equal(code, 0);
  assert.deepEqual(reports, [{ status: "failed", newSessions: 0, oldestPendingAgeMs: null }]);
  assert.deepEqual(stderr.mock.calls.map(call => JSON.parse(call.arguments[0])), [{ status: "failed", reason: "scan-failed" }]);
});
