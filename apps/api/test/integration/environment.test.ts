import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";

test("API can serve a request through Fastify", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  app.get("/health", async () => ({ ok: true }));
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { ok: true });
});
