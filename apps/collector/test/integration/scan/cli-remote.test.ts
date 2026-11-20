import assert from "node:assert/strict";
import { test } from "node:test";
import { RemoteCollectorCliFixture } from "../../fixtures/remote-collector-cli-fixture.ts";

test("a scan requires both remote settings when either is supplied", async t => {
  const fixture = await RemoteCollectorCliFixture.create(t);
  for (const [url, token] of [["private-address", undefined], [undefined, "private-token"], ["", undefined]]) {
    const result = await fixture.run(["scan", "--once"], url, token);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /TRACERELIC_COLLECTOR_API_URL.*TRACERELIC_COLLECTOR_TOKEN/);
    assert.doesNotMatch(result.stderr, /private-/);
  }
});

test("history reads local files even when the remote settings are invalid or incomplete", async t => {
  const fixture = await RemoteCollectorCliFixture.create(t);
  for (const token of [undefined, "private-token"]) {
    const result = await fixture.run(["history", "--from", "2026-02-01T00:00:00Z", "--to", "2026-02-02T00:00:00Z"], "invalid", token);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), []);
  }
});

test("an invalid command shows usage even with incomplete remote settings", async t => {
  const fixture = await RemoteCollectorCliFixture.create(t);
  const result = await fixture.run(["scan"], undefined, "private-token");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Usage: collector/);
});

for (const [command, args, status, runtime] of [["scan", ["scan", "--once"], 401, "bun"], ["watch", ["watch"], 403, "node"]] as const) {
  test(command + " stops when the API rejects its bearer credential", async t => {
    const fixture = await RemoteCollectorCliFixture.create(t);
    const api = await fixture.rejectCredentials(t, status);
    const result = await fixture.run([...args], api.url, "private-token", runtime);
    assert.equal(result.code, 1, result.stderr);
    assert.deepEqual(api.authorizations, ["Bearer private-token"]);
    assert.match(result.stderr, /authenticat|credential/i);
    assert.equal(result.stderr.trim().split("\n").length, 1);
    if (command === "watch") {
      assert.deepEqual(JSON.parse(result.stdout), { status: "failed", newSessions: 0, oldestPendingAgeMs: null });
    } else {
      assert.equal(result.stdout, "");
    }
    assert.doesNotMatch(result.stderr + result.stdout, /private-token|private response body/);
  });
}
