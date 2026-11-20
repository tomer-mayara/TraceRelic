import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CollectorApiProcess } from "../../fixtures/collector-api-process.ts";
import { credentialRecord } from "../../fixtures/collector-credential.ts";
import { DisposablePostgres } from "../../fixtures/disposable-postgres.ts";

test("the collector API entry point rejects missing or malformed configuration without printing its contents", async t => {
  const dir = await mkdtemp(join(tmpdir(), "tracerelic-api-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "credentials.json");
  const bad = "synthetic-token-outside-json";
  const missing = CollectorApiProcess.invalidConfiguration();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /TRACERELIC_COLLECTOR_CREDENTIALS_FILE/);
  assert.equal(missing.stdout, "");
  for (const contents of [bad, JSON.stringify([{ tokenSha256: bad }])]) {
    await writeFile(file, contents);
    const result = CollectorApiProcess.invalidConfiguration(file);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /credential/i);
    assert(!result.stderr.includes(bad));
  }
  await writeFile(file, "[]");
  for (const port of ["65536", "1e3"]) {
    const result = CollectorApiProcess.invalidConfiguration(file, port);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PORT/);
  }
  for (const databaseUrl of [undefined, "invalid-private-database-url", "postgresql://user:private-password@127.0.0.1:0/missing"]) {
    const result = CollectorApiProcess.invalidConfiguration(file, "0", databaseUrl);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DATABASE_URL/);
    assert.doesNotMatch(result.stderr, /private|postgresql:\/\//);
    assert.equal(result.stdout, "");
  }
});

test("the compiled API serves its configured workspaces, emits a commit metric, and shuts down on SIGTERM", async t => {
  const dir = await mkdtemp(join(tmpdir(), "tracerelic-api-service-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "credentials.json");
  const tokens = ["local-a", "local-b"];
  await writeFile(file, JSON.stringify(tokens.map((token, index) => credentialRecord(token, `team-${index}`, "laptop"))));
  const database = await DisposablePostgres.open();
  const server = new CollectorApiProcess(file, database.url);
  t.after(async () => {
    try { await server.stop("SIGTERM"); } finally { await database.close(); }
  });
  const started = await server.nextEvent();
  assert.equal(started.event, "listening");
  const address = new URL(started.address);
  assert.equal(address.hostname, "127.0.0.1");
  const post = async (route: string, token: string, input: unknown) => {
    const response = await fetch(new URL("/v1/collector/" + route, address), {
      method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const key = { harness: "codex", sessionId: "local-chat" };
  const batch = { source: { ...key, streamId: "source" }, expectedVersion: 0, expectedOffset: 0,
    checkpoint: { offset: 10, parserState: "{}" }, messages: [], usage: [] };
  assert.deepEqual(await post("batches", tokens[0], batch), { result: "committed" });
  const metric = await server.nextEvent();
  assert.deepEqual(Object.keys(metric).sort(), ["durationMs", "installationId", "operation", "outcome", "workspaceId"]);
  assert.deepEqual({ ...metric, durationMs: 0 }, { operation: "commit", outcome: "committed", workspaceId: "team-0", installationId: "laptop", durationMs: 0 });
  assert(Number.isFinite(metric.durationMs) && metric.durationMs >= 0);
  assert.partialDeepStrictEqual(await post("session", tokens[0], key), { session: { key } });
  assert.deepEqual(await post("session", tokens[1], key), { session: null });
  await database.close();
  const offline = await fetch(new URL("/v1/collector/batches", address), {
    method: "POST", headers: { authorization: "Bearer " + tokens[0], "content-type": "application/json" },
    body: JSON.stringify(batch), signal: AbortSignal.timeout(10_000),
  });
  assert.equal(offline.status, 503);
  assert.deepEqual(await offline.json(), { error: "storage-unavailable" });
  const outage = await server.nextEvent();
  assert.deepEqual({ ...outage, durationMs: 0 }, { ...metric, durationMs: 0, outcome: "storage-unavailable" });
  assert.deepEqual(await server.stop("SIGTERM"), [0, null]);
  assert.equal(server.stderr, "");
});
