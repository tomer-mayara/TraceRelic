import assert from "node:assert/strict";
import { test } from "node:test";
import { StorageUnavailableError } from "@tracerelic/collector/storage";
import { HttpStorageProbe } from "../fixtures/http-storage-probe.ts";

test("authenticate before interpreting a request or selecting storage", async t => {
  const probe = new HttpStorageProbe();
  await probe.start();
  t.after(() => probe.close());
  for (const path of ["session", "checkpoint", "sources", "presence", "batches"]) {
    for (const authorization of [null, "Bearer unknown"]) {
      const response = await probe.post(path, "{", authorization);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("www-authenticate"), "Bearer");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: "unauthorized" });
    }
  }
  assert.deepEqual(probe.lookups, []);
  assert.deepEqual(probe.metrics, []);
});

test("malformed JSON, missing bodies, oversized requests and other media have bounded error responses", async t => {
  const probe = new HttpStorageProbe();
  await probe.start();
  t.after(() => probe.close());
  for (const [body, type, status, error] of [
    ['{"private":', "application/json", 400, "bad-request"], [undefined, "application/json", 400, "bad-request"],
    ['"private"', "text/plain", 415, "unsupported-media-type"], ["a".repeat(1_048_577), "application/json", 413, "payload-too-large"],
  ] as const) {
    const response = await probe.post("batches", body, "Bearer fixture-token", type);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
  }
  for (const path of ["session", "checkpoint", "sources"]) {
    const response = await probe.post(path, "{}");
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "bad-request" });
  }
  assert.deepEqual(probe.lookups, []);
});

test("identity selectors in the body are rejected before workspace selection", async t => {
  const probe = new HttpStorageProbe();
  await probe.start();
  t.after(() => probe.close());
  for (const selector of [{ workspaceId: "elsewhere" }, { workspace: "elsewhere" }, { installationId: "laptop" }]) {
    for (const [path, body] of [["session", { ...probe.source, ...selector }], ["sources", { harness: "codex", root: "/tmp", ...selector }],
      ["checkpoint", { ...probe.source, ...selector }], ["batches", { ...probe.batch, ...selector }],
      ["batches", { ...probe.batch, source: { ...probe.source, ...selector } }],
      ["presence", { source: { ...probe.source, ...selector } }]] as const) {
      const response = await probe.post(path, JSON.stringify(body));
      assert.equal(response.status, 400, path);
      assert.deepEqual(await response.json(), { error: "bad-request" });
    }
  }
  assert.deepEqual(probe.lookups, []);
});

test("commit metrics identify verified scope, monotonic duration and typed outcome", async t => {
  const probe = new HttpStorageProbe();
  await probe.start();
  t.after(() => probe.close());
  for (const [outcome, status] of [["committed", 200], ["conflict", 409], ["invalid", 422]] as const) {
    probe.outcome = outcome;
    const response = await probe.post("batches", JSON.stringify(probe.batch));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { result: outcome });
  }
  assert.deepEqual(probe.lookups, ["team", "team", "team"]);
  assert(probe.writes.every(batch => batch.source.installationId === "desktop"));
  for (const [failure, status, error] of [[new StorageUnavailableError("private transport"), 503, "storage-unavailable"],
    [new Error("private storage"), 500, "internal-error"]] as const) {
    probe.outcome = failure;
    const response = await probe.post("batches", JSON.stringify(probe.batch));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
  }
  const response = await probe.post("batches", JSON.stringify({ ...probe.batch, usage: null }));
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { result: "invalid" });
  assert.equal(probe.writes.length, 5);
  assert.deepEqual(probe.metrics.map(({ durationMs, ...event }) => {
    assert(Number.isFinite(durationMs) && durationMs >= 0);
    return event;
  }), ["committed", "conflict", "invalid", "storage-unavailable", "internal-error", "invalid"].map(outcome => ({
    operation: "commit", ...probe.scope, outcome,
  })));
});

test("a failed metric sink preserves the acknowledged write", async t => {
  const probe = new HttpStorageProbe(() => { throw new Error("observer failed"); });
  await probe.start();
  t.after(() => probe.close());
  const response = await probe.post("batches", JSON.stringify(probe.batch));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { result: "committed" });
  assert.equal(probe.writes.length, 1);
});
