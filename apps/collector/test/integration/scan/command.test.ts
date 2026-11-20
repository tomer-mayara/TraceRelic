import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { test } from "node:test";
import { CollectorCommand } from "@tracerelic/collector/command";
import { CodexRolloutFixture as Rollout } from "../../fixtures/codex-rollout-fixture.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";
import { LocalCollectorCliFixture } from "../../fixtures/local-collector-cli-fixture.ts";
import { ScanCommandFixture } from "../../fixtures/scan-command-fixture.ts";

test("the standalone scan prints the selected planning chat from the configured root", async t => {
  const fixture = await LocalCollectorCliFixture.create();
  t.after(() => fixture.close());
  const config = await fixture.writeConfig("..");
  await fixture.writeChat(fixture.configured, "selected");
  await fixture.writeChat(fixture.elsewhere, "environment");
  await fixture.configured.write([Rollout.header("other"), Rollout.message("2026-02-01T13:00:00Z", "other")], true);
  const result = fixture.run(["--config", config, "scan", "--once", "--session", "selected"]);
  assert.equal(result.status, 0, result.stderr);
  const sessions: unknown = JSON.parse(result.stdout);
  assert(Array.isArray(sessions));
  assert.equal(sessions.length, 1);
  assert.partialDeepStrictEqual(sessions[0], {
    key: { harness: "codex", sessionId: "selected" }, messages: [{ role: "user", text: "selected" }],
    observedTotalTokens: null, coverage: "unknown",
  });
});

test("two workspaces select their own chats and a restarted scanner keeps earlier messages", async t => {
  const fixture = await LocalCollectorCliFixture.create();
  t.after(() => fixture.close());
  const config = await fixture.writeConfig("..");
  const args = ["scan", "--once", "--config", config];
  const at = "2026-02-01T12:00:00Z";
  const active = await fixture.configured.write([
    Rollout.header("first"), Rollout.turnContext(at, "turn-1"),
    { timestamp: at, type: "event_msg", payload: { type: "user_message", message: "first" } },
  ]);
  const header = Rollout.header("second");
  await fixture.configured.write([{ ...header, payload: { ...header.payload, cwd: "/workspace/second" } },
    Rollout.message("2026-02-01T14:00:00Z", "Second project")], true);
  const one = new InMemoryCollectorStorage();
  const two = new InMemoryCollectorStorage();
  const first = { harness: "codex", sessionId: "first" } as const;
  const second = { harness: "codex", sessionId: "second" } as const;
  await new CollectorCommand(one).run([...args, "--session", "first"]);
  await new CollectorCommand(two).run([...args, "--project", "/workspace/second"]);
  assert.equal(await one.readSession(second), null);
  assert.equal(await two.readSession(first), null);
  assert.equal((await two.readSession(second))?.messages[0].text, "Second project");
  const previous = await one.readSession(first);
  assert(previous);
  const mirror = Rollout.message(at, "fi");
  mirror.payload.content.push({ type: "input_text", text: "rst" });
  const next = Rollout.message("2026-02-01T11:00:00Z", "Follow-up");
  await appendFile(active, [mirror, next].map(row => JSON.stringify(row) + "\n").join(""));
  await new CollectorCommand(one).run([...args, "--session", "first"]);
  const refreshed = await one.readSession(first);
  assert(refreshed);
  assert.deepEqual(refreshed.messages.slice(0, 1), previous.messages);
  assert.deepEqual(refreshed.messages.map(message => message.text), ["first", "Follow-up"]);
});

test("an undated branch change has the same result on a fresh scan and after an append", async t => {
  const fixture = await LocalCollectorCliFixture.create();
  t.after(() => fixture.close());
  const args = ["scan", "--once", "--config", await fixture.writeConfig("..")];
  const header = Rollout.header("branch-switch");
  const path = await fixture.configured.write([
    { ...header, payload: { ...header.payload, git: { branch: "main" } } },
    Rollout.message("2026-02-01T12:00:00Z", "Plan"),
  ]);
  const first = new CollectorCommand(new InMemoryCollectorStorage());
  await first.run(args);
  const records = [
    { type: "turn_context", payload: { turn_id: "next", git: { branch: "topic" } } },
    Rollout.message("2026-02-01T12:01:00Z", "Follow up"),
  ];
  await appendFile(path, records.map(record => JSON.stringify(record) + "\n").join(""));
  const appended = await first.run(args);
  const fresh = await new CollectorCommand(new InMemoryCollectorStorage()).run(args);
  assert.deepEqual(appended, fresh);
  assert.partialDeepStrictEqual(appended[0], { metadata: { branch: "topic" } });
});

for (const outcome of ["conflict", "invalid"] as const) {
  test(`scan reports the source and byte range when storage returns ${outcome}`, async t => {
    const fixture = await ScanCommandFixture.create();
    t.after(() => fixture.close());
    await fixture.configure();
    await fixture.writePlanningChat("private chat text", "private reply");
    t.mock.method(fixture.storage, "commit", async () => outcome);
    await assert.rejects(fixture.scan(), (error: unknown) => {
      assert(error instanceof Error);
      assert(error.message.includes(outcome));
      assert.match(error.message, /rollout-.*\.jsonl/);
      assert.match(error.message, /bytes 0\.\.[1-9]\d*/);
      assert.doesNotMatch(error.message, /private chat text|private reply/);
      return true;
    });
  });
}
