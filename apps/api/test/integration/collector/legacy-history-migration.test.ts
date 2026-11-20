import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreLegacyCoverage } from "../../fixtures/collector-database-write.ts";
import { PostgresCollectorDatabase } from "#src/storage/collector-database";
import { PostgresCollectorStorage } from "#src/storage/postgres-collector-storage";
import { batch, presence } from "../../fixtures/collector-wire-payloads.ts";
import { DisposablePostgres } from "../../fixtures/disposable-postgres.ts";

test("startup corrects already materialized missing and reset legacy summaries before any collector reconnects", async t => {
  const postgres = await DisposablePostgres.open();
  t.after(() => postgres.close());
  const first = await PostgresCollectorDatabase.open(postgres.url);
  const old = new PostgresCollectorStorage(first, "workspace");
  const cases = ["missing", "reset", "opaque"] as const;
  try {
    for (const name of cases) {
      const source = { ...batch.source, sessionId: name, installationId: "desk\u0000top" };
      const parserState = name === "opaque" ? "custom\ud800" : JSON.stringify({ version: 2, lineNumber: 3, decoder: {} });
      const checkpoint = { ...batch.checkpoint, parserState };
      assert.equal(await old.commit({ ...batch, source, checkpoint }), "committed");
      if (name === "reset") assert.equal(await old.commit({ ...batch, source, expectedVersion: 1,
        expectedOffset: checkpoint.offset, resetFrom: checkpoint, checkpoint: { ...checkpoint, prefixDigest: "b".repeat(64) } }), "committed");
      else assert.equal(await old.recordPresence({ ...presence, source }), "committed");
    }
    await restoreLegacyCoverage(postgres.url);
  } finally {
    await first.close();
  }
  const migrated = await PostgresCollectorDatabase.open(postgres.url);
  try {
    for (const name of cases) {
      const source = { ...batch.source, sessionId: name, installationId: "desk\u0000top" };
      const view = await migrated.readSession("workspace", source);
      assert.equal(view?.observedTotalTokens, 130);
      assert.equal(view?.coverage, name === "opaque" ? "reported" : "partial");
      assert.deepEqual(view?.usageDiagnostics?.map(row => [row.code, row.installationId]),
        name === "opaque" ? undefined : [["unverified-source-history", source.installationId]]);
      assert.equal((await migrated.readCheckpoint("workspace", source)).version, 2);
    }
  } finally { await migrated.close(); }
});
