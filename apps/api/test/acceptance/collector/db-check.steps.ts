import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { After, Given, Then, When } from "@cucumber/cucumber";
import { Pool } from "pg";
import { DisposablePostgres } from "../../fixtures/disposable-postgres.ts";

interface DatabaseCheckScenario {
  postgres?: DisposablePostgres;
  databaseUrl: string;
  result: SpawnSyncReturns<string>;
}

Given("PostgreSQL is available to the database check", { timeout: 90_000 }, async function (this: DatabaseCheckScenario) {
  this.postgres = await DisposablePostgres.open();
  this.databaseUrl = this.postgres.url;
});

After({ tags: "@db-check" }, async function (this: DatabaseCheckScenario) {
  await this.postgres?.close();
});

Given("the database check has an unreachable PostgreSQL address", function (this: DatabaseCheckScenario) {
  this.databaseUrl = "postgresql://synthetic_user:synthetic_password@127.0.0.1:0/synthetic_db";
});

When("I run the database check", function (this: DatabaseCheckScenario) {
  this.result = spawnSync("bun", ["run", "--silent", "db:check"], {
    cwd: new URL("../../", import.meta.resolve("@tracerelic/api/package.json")),
    env: { ...process.env, DATABASE_URL: this.databaseUrl },
    encoding: "utf8",
    timeout: 10_000,
  });
  if (this.result.error) throw this.result.error;
});

Then("stdout contains one JSON object with the database name and server version", async function (this: DatabaseCheckScenario) {
  const lines = this.result.stdout.split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[1], "");
  const db = new Pool({ connectionString: this.databaseUrl });
  try {
    const { rows } = await db.query<{ server_version: string }>("SHOW server_version");
    assert.deepEqual(JSON.parse(lines[0]), {
      database: decodeURIComponent(new URL(this.databaseUrl).pathname.slice(1)),
      version: rows[0].server_version,
    });
  } finally {
    await db.end();
  }
});

Then("the check exits successfully with empty stderr", function (this: DatabaseCheckScenario) {
  assert.equal(this.result.status, 0);
  assert.equal(this.result.stderr, "");
});

Then("stderr contains one ERROR for the failed database check", function (this: DatabaseCheckScenario) {
  const { stderr } = this.result;
  assert.doesNotMatch(stderr, /synthetic_|127\.0\.0\.1|\n\s+at /);
  const diagnostic = /^(\S+) ERROR (?:[^\r\n]*[/\\])?check-db\.ts:[1-9]\d* Database check failed\. Check DATABASE_URL and database access\.\n$/;
  const fields = diagnostic.exec(stderr);
  assert(fields, "Expected one timestamped ERROR from the database check");
  assert.equal(fields[1], new Date(fields[1]).toISOString());
});

Then("the check exits with status {int} and leaves stdout empty", function (this: DatabaseCheckScenario, status: number) {
  assert.equal(this.result.status, status);
  assert.equal(this.result.stdout, "");
});
