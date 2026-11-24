import assert from "node:assert/strict";
import { test } from "node:test";
import { StorageAuthenticationError, StorageBackoffError, StorageUnavailableError } from "#src/storage/collector-storage";
import { HttpCollectorStorage } from "#src/storage/http/http-collector-storage";
import { apiOrigin, CollectorHttpTransport, inventory, session, sessionKey, token } from "../../../fixtures/collector-http-transport.ts";
import { inventoryScope, inventorySource, measuredSource, presence } from "../../../fixtures/source-inventory-fixture.ts";

test("the five storage operations use the versioned authenticated JSON endpoints", async () => {
  const wire = new CollectorHttpTransport();
  const client = new HttpCollectorStorage(apiOrigin, token, { fetch: wire.fetch });
  const batch = measuredSource();
  const update = presence(1, "missing");
  const snapshot = { version: 1, checkpoint: batch.checkpoint };
  wire.reply(200, { session });
  assert.deepEqual(await client.readSession(inventorySource), session);
  wire.reply(200, snapshot);
  assert.deepEqual(await client.readCheckpoint(inventorySource), snapshot);
  wire.reply(200, [inventory]);
  assert.deepEqual(await client.listSources(inventoryScope), [inventory]);
  wire.reply(200, { result: "committed" });
  assert.equal(await client.commit(batch), "committed");
  assert.equal(await client.recordPresence(update), "committed");

  const routes = ["session", "checkpoint", "sources", "batches", "presence"];
  const payloads = [sessionKey, inventorySource, inventoryScope, batch, update];
  assert.equal(wire.requests.length, routes.length);
  for (const [i, request] of wire.requests.entries()) {
    assert.equal(request.url, apiOrigin + "/v1/collector/" + routes[i]);
    assert.equal(request.method, "POST");
    assert.equal(request.redirect, "manual");
    assert.equal(request.headers.get("authorization"), "Bearer " + token);
    assert.equal(request.headers.get("content-type"), "application/json");
    assert.deepEqual(await request.json(), payloads[i]);
  }
});

test("an omitted installation uses local source keys and an explicit installation stays distinct", async () => {
  const wire = new CollectorHttpTransport();
  const client = new HttpCollectorStorage(apiOrigin, token, { fetch: wire.fetch });
  wire.reply(200, [inventory]);
  const scope = { harness: inventoryScope.harness, root: inventoryScope.root };
  const result = await client.listSources(scope);
  assert.deepEqual(result[0].source, { ...sessionKey, streamId: inventorySource.streamId });
  assert.deepEqual(await wire.requests[0].json(), scope);
  assert.deepEqual(await client.listSources(inventoryScope), [inventory]);
  wire.reply(200, { session: null });
  assert.equal(await client.readSession(inventorySource), null);
});

test("batch and presence writes preserve the three storage outcomes and verify their status", async () => {
  const wire = new CollectorHttpTransport();
  const client = new HttpCollectorStorage(apiOrigin, token, { fetch: wire.fetch });
  for (const [status, result] of [[200, "committed"], [409, "conflict"], [422, "invalid"]] as const) {
    wire.reply(status, { result });
    assert.equal(await client.commit(measuredSource()), result);
    assert.equal(await client.recordPresence(presence(1, "missing")), result);
    wire.reply(status, { result: status === 200 ? "invalid" : "committed" });
    await assert.rejects(client.commit(measuredSource()), /invalid response/i);
  }
  wire.reply(422, { error: "private validation message" });
  await assert.rejects(client.commit(measuredSource()), /invalid response/i);
});

test("the client rejects a successful read with an invalid nested value or an unexpected identity", async () => {
  const wire = new CollectorHttpTransport();
  const client = new HttpCollectorStorage(apiOrigin, token, { fetch: wire.fetch });
  wire.reply(200, { session: { ...session, usage: [{ ...session.usage[0], outputTokens: -1 }] } });
  await assert.rejects(client.readSession(inventorySource), /invalid response/i);
  wire.reply(200, { session: { ...session, key: { ...sessionKey, sessionId: "unrelated" } } });
  await assert.rejects(client.readSession(inventorySource), /invalid response/i);
  wire.reply(200, { version: 1, checkpoint: { offset: -1, parserState: "{}" } });
  await assert.rejects(client.readCheckpoint(inventorySource), /invalid response/i);
  wire.reply(200, [inventory, { ...inventory, source: {} }]);
  await assert.rejects(client.listSources(inventoryScope), /invalid response/i);
  wire.reply(200, [inventory]);
  await assert.rejects(client.listSources({ ...inventoryScope, installationId: "another" }), /invalid response/i);
});

test("an oversized batch is rejected at its source and other bad responses are diagnostic errors", async () => {
  const wire = new CollectorHttpTransport();
  const client = new HttpCollectorStorage(apiOrigin, token, { fetch: wire.fetch });
  wire.respond = () => new Response("private payload", { status: 413 });
  assert.equal(await client.commit(measuredSource()), "invalid");
  for (const status of [400, 413, 415]) {
    wire.respond = () => new Response("private payload", { status });
    await assert.rejects(client.recordPresence(presence(1, "missing")), error => {
      assert(error instanceof Error && !(error instanceof StorageUnavailableError));
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
  }
  wire.respond = () => new Response('{"private content"');
  await assert.rejects(client.commit(measuredSource()), error => {
    assert(error instanceof Error && !(error instanceof StorageUnavailableError));
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
});

test("a temporary response delays the next attempt using seconds or an HTTP date", async () => {
  const wire = new CollectorHttpTransport();
  const now = Date.UTC(2026, 0, 1, 0, 0, 0, 250);
  const client = new HttpCollectorStorage(apiOrigin, token, { fetch: wire.fetch, now: () => now });
  for (const [status, header, expected] of [
    [429, "3", 3000], [429, new Date(now + 5750).toUTCString(), 5750], [503, "10", 10_000],
    [500, undefined, 1000], [502, undefined, 1000], [504, undefined, 1000], [429, "0", 1000],
    [429, new Date(now - 4000).toUTCString(), 1000], [429, "1.5", 1000], [408, "bad-header", 1000],
  ] as const) {
    wire.reply(status, { detail: "private response" }, header === undefined ? {} : { "Retry-After": header });
    const before = wire.requests.length;
    await assert.rejects(client.commit(measuredSource()), error => {
      assert(error instanceof StorageBackoffError);
      assert.equal(error.retryAfterMs, expected);
      return true;
    });
    assert.equal(wire.requests.length, before + 1);
  }
});

test("Retry-After recognizes HTTP dates, including older forms, and ignores invalid calendar values", async () => {
  const wire = new CollectorHttpTransport();
  const now = Date.UTC(2026, 0, 1);
  const client = new HttpCollectorStorage(apiOrigin, token, { fetch: wire.fetch, now: () => now });
  for (const [header, expected] of [
    ["Fri, 02 Jan 2026 00:00:00 GMT", 86_400_000], ["Friday, 02-Jan-26 00:00:00 GMT", 86_400_000],
    ["Fri Jan  2 00:00:00 2026", 86_400_000], ["Thursday, 01-Jan-60 00:00:00 GMT", Date.UTC(2060, 0, 1) - now],
    ["Thu, 01 Jan 2099 00:00:00 GMT+0200", 1000], ["Tue, 31 Feb 2026 00:00:00 GMT", 1000],
    ["Thu, 02 Jan 2026 00:00:00 GMT", 1000], ["Fri, 2 Jan 2026 00:00:00 GMT", 1000],
    ["Wed Jan 2 00:00:00 2099", 1000], ["Tuesday, 03-Mar-26 24:00:00 GMT", 1000],
    ["9".repeat(500), Number.MAX_SAFE_INTEGER],
  ] as const) {
    wire.reply(429, null, { "Retry-After": header });
    await assert.rejects(client.listSources(inventoryScope), error => {
      assert(error instanceof StorageBackoffError);
      assert.equal(error.retryAfterMs, expected, header);
      return true;
    });
  }
});

test("a missing or rejected credential stops the caller without exposing diagnostic bodies", async () => {
  const wire = new CollectorHttpTransport();
  for (const credential of ["", "bad token", "private\nheader"]) {
    assert.throws(() => new HttpCollectorStorage(apiOrigin, credential, { fetch: wire.fetch }), StorageAuthenticationError);
  }
  assert.equal(wire.requests.length, 0);
  const client = new HttpCollectorStorage(apiOrigin, token, { fetch: wire.fetch });
  for (const status of [401, 403]) {
    wire.respond = () => new Response("private response body", { status });
    await assert.rejects(client.readCheckpoint(inventorySource), error => {
      assert(error instanceof StorageAuthenticationError);
      assert.doesNotMatch(error.message, /private|fixture\.opaque/);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test("a lost connection or timeout leaves one unconfirmed write and a sanitized transport error", async () => {
  const wire = new CollectorHttpTransport();
  const client = new HttpCollectorStorage(apiOrigin, token, { fetch: wire.fetch, timeoutMs: 20 });
  wire.respond = () => { throw new TypeError("private network diagnostic"); };
  for (const stage of ["offline", "headers", "body"] as const) {
    if (stage !== "offline") wire.stall(stage);
    const before = wire.requests.length;
    await assert.rejects(client.commit(measuredSource()), error => {
      assert(error instanceof StorageUnavailableError && !(error instanceof StorageBackoffError));
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.message, /private|fixture\.opaque/);
      return true;
    });
    assert.equal(wire.requests.length, before + 1);
  }
});

test("the credential is sent only to the configured HTTPS or loopback origin", async () => {
  const wire = new CollectorHttpTransport();
  for (const url of ["http://collector.example.test", "ftp://127.0.0.1", "http://127.0.0.1.example.test",
    "https://user:private@example.test", apiOrigin + "/unexpected", apiOrigin + "?private", apiOrigin + "#private", "bad private URL"]) {
    assert.throws(() => new HttpCollectorStorage(url, token, { fetch: wire.fetch }), error => {
      assert(error instanceof Error);
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
  }
  assert.equal(wire.requests.length, 0);
  wire.respond = () => Response.redirect("https://other.example.test/private", 307);
  for (const origin of [apiOrigin, "http://localhost:3000", "http://127.0.0.1:5000", "http://[::1]"]) {
    const client = new HttpCollectorStorage(origin, token, { fetch: wire.fetch });
    await assert.rejects(client.readSession(sessionKey), error => {
      assert(error instanceof Error && !(error instanceof StorageUnavailableError));
      assert.doesNotMatch(error.message, /private|fixture\.opaque/);
      return true;
    });
  }
  assert.equal(wire.requests.length, 4);
  assert(wire.requests.every(request => request.redirect === "manual"));
});
