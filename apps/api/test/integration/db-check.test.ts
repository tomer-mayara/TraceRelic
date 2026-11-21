import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { DisposablePostgres } from "../fixtures/disposable-postgres.ts";

test("losing the PostgreSQL connection during the check produces one safe diagnostic", async t => {
  const db = await DisposablePostgres.open();
  t.after(() => db.close());
  // Close the real pg socket as soon as the check sends its query.
  const interrupt = `
    import { Client } from "pg";
    const query = Client.prototype.query;
    Client.prototype.query = function (...args) {
      const pending = query.apply(this, args);
      this.connection.stream.destroy();
      return pending;
    };
    await import("./scripts/check-db.ts");
  `;
  const result = spawnSync("bun", ["--conditions=source", "--eval", interrupt], {
    cwd: new URL(".", import.meta.resolve("@tracerelic/api/package.json")),
    env: { ...process.env, DATABASE_URL: db.url }, encoding: "utf8", timeout: 10_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^\S+ ERROR [^\r\n]+ Database check failed\. Check DATABASE_URL and database access\.\n$/);
});
