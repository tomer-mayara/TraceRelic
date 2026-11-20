import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { test } from "node:test";
import { runCollectorCli } from "#src/cli";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";
import { LocalCollectorCliFixture } from "../../fixtures/local-collector-cli-fixture.ts";
import { DroppedConnection } from "../../fixtures/lost-connection-fixture.ts";

test("the one-time CLI reports pending bytes on standard error and exits with temporary failure", async t => {
  const fixture = await LocalCollectorCliFixture.create();
  t.after(() => fixture.close());
  const file = await fixture.writeChat(fixture.configured, "offline");
  const config = await fixture.writeConfig(fixture.configured.home);
  const connection = new DroppedConnection(new InMemoryCollectorStorage());
  connection.dropNextWrite("before storage writes");
  const stdout = t.mock.method(console, "log", () => {});
  const stderr = t.mock.method(console, "error", () => {});

  assert.equal(await runCollectorCli(["scan", "--once", "--config", config], connection), 75);
  assert.equal(stdout.mock.callCount(), 0);
  assert.equal(stderr.mock.callCount(), 1);
  const [line] = stderr.mock.calls[0].arguments;
  assert.equal(typeof line, "string");
  const report = JSON.parse(line);
  assert.partialDeepStrictEqual(report, {
    status: "pending", reason: "storage-unavailable", source: { harness: "codex", sessionId: "offline" },
    byteRange: { startOffset: 0, endOffset: (await stat(file)).size },
  });
  assert(Number.isFinite(Date.parse(report.retryAt)));
  assert.doesNotMatch(line, /private transport detail/);
});
