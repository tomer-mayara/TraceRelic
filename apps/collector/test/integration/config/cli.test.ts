import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalCollectorCliFixture } from "../../fixtures/local-collector-cli-fixture.ts";
import { CodexRolloutFixture as Rollout } from "../../fixtures/codex-rollout-fixture.ts";

test("project scan uses the dialect of the recorded cwd and keeps explicit session selection", async t => {
  const fixture = await LocalCollectorCliFixture.create();
  t.after(() => fixture.close());
  const file = await fixture.writeConfig("..");
  const scan = (filter: string, value: string) => {
    const result = fixture.run(["scan", "--once", "--config", file, filter, value]);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).map((row: { key: { sessionId: string } }) => row.key.sessionId);
  };
  const header = Rollout.header("foreign");
  for (const cwd of ["relative-repo", String.raw`C:\Foreign\Repo`]) {
    await fixture.configured.write([{ ...header, payload: { ...header.payload, cwd } }, Rollout.message("2026-02-01T12:00:00Z", "hello")]);
    assert.deepEqual(scan("--project", "."), []);
    assert.deepEqual(scan("--session", "foreign"), ["foreign"]);
  }
  assert.deepEqual(scan("--project", "c:/foreign"), ["foreign"]);
  assert.deepEqual(scan("--project", "d:/foreign"), []);
});

test("history requires an explicit config even when the environment points to Codex", async (t) => {
  const fixture = await LocalCollectorCliFixture.create();
  t.after(() => fixture.close());
  const result = fixture.run(["history", "--from", "2026-02-01T00:00:00Z", "--to", "2026-02-02T00:00:00Z"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Usage: collector history --config/);
});

test("history rejects an invalid instant without opening the config", async (t) => {
  const fixture = await LocalCollectorCliFixture.create();
  t.after(() => fixture.close());
  const result = fixture.run(["history", "--config", "missing.json", "--from", "yesterday", "--to", "2026-02-02T00:00:00Z"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Expected an ISO date and time with a timezone for --from/);
});

test("the global config option may precede the history command", async (t) => {
  const fixture = await LocalCollectorCliFixture.create();
  t.after(() => fixture.close());
  const file = await fixture.writeConfig("..");
  const result = fixture.run(["--config", file, "history", "--from", "2026-02-01T00:00:00Z", "--to", "2026-02-02T00:00:00Z"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test("the CLI distinguishes adjacent sub-millisecond windows, offsets and reversed bounds", async t => {
  const fixture = await LocalCollectorCliFixture.create();
  t.after(() => fixture.close());
  const file = await fixture.writeConfig("..", "../claude");
  const at = "2026-02-01T12:00:00.0003Z";
  await fixture.writeChat(fixture.configured, "c", at);
  await fixture.writeClaudeChat("h", at);
  const read = (from: string, to: string) => fixture.run(["history", "--config", file, "--from", from, "--to", to]);
  const before = "2026-02-01T07:00:00.0002-05:00";
  const after = "2026-02-01T12:00:00.0007Z";
  assert.deepEqual(JSON.parse(read(before, at).stdout), []);
  assert.equal(JSON.parse(read(at, after).stdout).length, 2);
  assert.equal(read(after, before).status, 1);
});
