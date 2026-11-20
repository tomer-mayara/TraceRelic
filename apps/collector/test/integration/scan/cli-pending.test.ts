import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { runCollectorCli } from "#src/cli";
import { captureCollectorCli } from "../../fixtures/capture-collector-cli.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";
import { LocalCollectorCliFixture } from "../../fixtures/local-collector-cli-fixture.ts";
import { DroppedConnection } from "../../fixtures/lost-connection-fixture.ts";
import { PresenceConnection } from "../../fixtures/presence-connection.ts";

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

test("the CLI identifies the selected root when its source inventory is unavailable", async t => {
  const fixture = await LocalCollectorCliFixture.create();
  t.after(() => fixture.close());
  const config = await fixture.writeConfig(fixture.configured.home);
  const storage = new InMemoryCollectorStorage();
  t.mock.method(storage, "listSources", async () => {
    throw Object.assign(new Error("private transport detail"), { code: "ECONNRESET" });
  });
  const result = await captureCollectorCli(t, ["scan", "--once", "--config", config, "--session", "gone"], storage);
  assert.equal(result.code, 75);
  assert.deepEqual(result.stdout, []);
  assert.equal(result.stderr.length, 1);
  const pending = JSON.parse(result.stderr[0]);
  assert.partialDeepStrictEqual(pending, { status: "pending", reason: "storage-unavailable",
    scope: { harness: "codex", root: fixture.configured.home, sessionIds: ["gone"] } });
  assert.equal(pending.source, undefined);
  assert.equal(pending.byteRange, undefined);
  assert(Number.isFinite(Date.parse(pending.retryAt)));
  assert.doesNotMatch(result.stderr[0], /private transport detail/);
});

test("an empty Codex root does not hide the Claude transcript awaiting its first upload", async t => {
  const fixture = await LocalCollectorCliFixture.create();
  t.after(() => fixture.close());
  await fixture.writeClaudeChat("claude-only");
  const config = await fixture.writeConfig(fixture.elsewhere.home, join(fixture.configured.home, "claude"));
  const storage = new PresenceConnection();
  storage.offline = true;
  const result = await captureCollectorCli(t, ["scan", "--once", "--config", config], storage);
  assert.equal(result.code, 75);
  assert.deepEqual(result.stdout, []);
  assert.equal(result.stderr.length, 1);
  assert.partialDeepStrictEqual(JSON.parse(result.stderr[0]), {
    status: "pending", reason: "storage-unavailable", source: { harness: "claude", sessionId: "claude-only" },
  });
});
