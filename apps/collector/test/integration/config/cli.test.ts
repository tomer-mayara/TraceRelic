import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalCollectorCliFixture } from "../../fixtures/local-collector-cli-fixture.ts";

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
