import assert from "node:assert/strict";
import { test } from "node:test";
import { batch, key, presence, scope, session, source, storedSource } from "../../fixtures/collector-wire-payloads.ts";
import { acceptsBody, published, section } from "../../fixtures/published-collector-api.ts";

const operations = {
  batches: ["commit", batch], checkpoint: ["readCheckpoint", source], presence: ["recordPresence", presence],
  session: ["readSession", key], sources: ["listSources", scope],
} as const;

test("OpenAPI publishes five authenticated JSON operations under version one", () => {
  assert.equal(published.openapi, "3.1.0");
  assert.equal(section(published, "info").version, "1.0.0");
  assert.deepEqual(section(published, "components", "securitySchemes", "BearerAuth"), { type: "http", scheme: "Bearer" });
  assert.deepEqual(Object.keys(section(published, "paths")).sort(), Object.keys(operations).map(name => `/v1/collector/${name}`).sort());
  for (const [resource, [operationId, request]] of Object.entries(operations)) {
    const path = section(published, "paths", `/v1/collector/${resource}`);
    assert.deepEqual(Object.keys(path), ["post"]);
    const op = section(path, "post");
    assert.equal(op.operationId, operationId);
    assert.deepEqual(op.security ?? published.security, [{ BearerAuth: [] }]);
    assert.equal(section(op, "requestBody").required, true);
    assert(acceptsBody(resource, "request", request));
    assert.equal(acceptsBody(resource, "request", null), false);
    const challenge = section(op, "responses", "401", "headers", "WWW-Authenticate");
    assert.equal(challenge.required, true);
    assert.deepEqual(section(challenge, "schema").enum, ["Bearer"]);
  }
});

test("the public read results distinguish a missing session, an empty inventory and a fresh checkpoint", () => {
  for (const [resource, body] of [["session", { session }], ["session", { session: null }], ["sources", []],
    ["sources", [storedSource]], ["checkpoint", { version: 0, checkpoint: null }],
    ["checkpoint", { version: 1, checkpoint: batch.checkpoint }]] as const) {
    assert(acceptsBody(resource, 200, body), resource);
  }
  assert.equal(acceptsBody("session", 200, session), false);
  assert.equal(acceptsBody("checkpoint", 200, null), false);
  assert.equal(acceptsBody("sources", 200, [source]), false);
});

test("the published status codes select the exact write outcome or error", () => {
  for (const resource of ["batches", "presence"]) {
    for (const [status, result] of [[200, "committed"], [409, "conflict"], [422, "invalid"]] as const) {
      assert(acceptsBody(resource, status, { result }));
      assert.equal(acceptsBody(resource, status, { result: status === 200 ? "invalid" : "committed" }), false);
    }
  }
  for (const resource of Object.keys(operations)) {
    for (const [status, error] of [[400, "bad-request"], [401, "unauthorized"], [413, "payload-too-large"],
      [415, "unsupported-media-type"], [500, "internal-error"], [503, "storage-unavailable"]] as const) {
      assert(acceptsBody(resource, status, { error }));
      assert.equal(acceptsBody(resource, status, { result: "invalid" }), false);
    }
  }
});

test("clients can read a Retry-After header on rate limits and service outages", () => {
  for (const route of Object.keys(operations)) {
    const responses = section(published, "paths", `/v1/collector/${route}`, "post", "responses");
    for (const status of ["429", "503"]) {
      const header = section(responses, status, "headers", "Retry-After");
      assert.equal(section(header, "schema").type, "string");
      assert.notEqual(header.required, true);
    }
  }
});
