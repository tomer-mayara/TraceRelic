import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { CollectorCli } from "#src/cli";
import { PresenceConnection } from "../../fixtures/presence-connection.ts";
import { ScanCommandFixture } from "../../fixtures/scan-command-fixture.ts";

test("a command waits for its last diagnostic before returning its exit code", async t => {
  const written = Promise.withResolvers<void>();
  const stderr = t.mock.method(process.stderr, "write", (_chunk: string, done: () => void) => {
    void written.promise.then(done);
    return true;
  });
  let settled = false;
  const exit = CollectorCli.run([]).then(code => { settled = true; return code; });
  try {
    await setImmediate();
    assert.equal(settled, false);
    assert.equal(stderr.mock.callCount(), 1);
  } finally {
    written.resolve();
  }
  assert.equal(await exit, 1);
});

test("a diagnostic write failure preserves a pending exit and fails an otherwise successful watch", async t => {
  const storage = new PresenceConnection();
  storage.offline = true;
  const fixture = await ScanCommandFixture.create(storage);
  t.after(() => fixture.close());
  await fixture.configure();
  const stop = new AbortController();
  const stdout = t.mock.method(console, "log", () => { stop.abort(); });
  const stderr = t.mock.method(process.stderr, "write", () => { throw new Error("stderr write failed"); });

  assert.equal(await CollectorCli.run(["scan", "--once", "--config", fixture.configFile], storage), 75);
  assert.equal(stdout.mock.callCount(), 0);
  const code = await CollectorCli.run(["watch", "--config", fixture.configFile], storage, { signal: stop.signal });
  assert.equal(code, 1);
  assert.equal(stderr.mock.callCount(), 2);
  assert.equal(stdout.mock.callCount(), 1);
  assert.equal(JSON.parse(stdout.mock.calls[0].arguments[0]).status, "pending");
});
