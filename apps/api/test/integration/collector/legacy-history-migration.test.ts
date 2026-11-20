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
  const versioned = JSON.stringify({ version: 2, lineNumber: 3, decoder: {} });
  const rollout = "rollout-fixture.jsonl";
  const cases = [
    { name: "missing", parserState: versioned, partial: true },
    { name: "reset", parserState: versioned, partial: true, reset: true },
    { name: "missing-empty", parserState: "{}", partial: true, streamId: rollout },
    { name: "reset-empty", parserState: "", partial: true, streamId: rollout, reset: true },
    { name: "opaque", parserState: "custom\ud800", partial: false },
    { name: "opaque-empty", parserState: "{}", partial: false, streamId: "adapter-slot" },
    { name: "opaque-on-rollout", parserState: "\u00a0{}", partial: false, streamId: rollout },
  ];
  const key = (sessionId: string, streamId = batch.source.streamId) => ({ ...batch.source, sessionId, streamId, installationId: "desk\u0000top" });
  try {
    for (const item of cases) {
      const source = key(item.name, item.streamId);
      const location = { ...presence.location, path: rollout };
      const checkpoint = { ...batch.checkpoint, parserState: item.parserState };
      assert.equal(await old.commit({ ...batch, source, checkpoint, sourceObservation: { ...batch.sourceObservation, location } }), "committed");
      if (item.reset) assert.equal(await old.commit({ ...batch, source, sourceObservation: undefined, expectedVersion: 1,
        expectedOffset: checkpoint.offset, resetFrom: checkpoint, checkpoint: { ...checkpoint, prefixDigest: "b".repeat(64) } }), "committed");
      else assert.equal(await old.recordPresence({ ...presence, source, location }), "committed");
    }
    await restoreLegacyCoverage(postgres.url);
  } finally {
    await first.close();
  }
  const migrated = await PostgresCollectorDatabase.open(postgres.url);
  try {
    for (const item of cases) {
      const source = key(item.name, item.streamId);
      const view = await migrated.readSession("workspace", source);
      assert.equal(view?.observedTotalTokens, 130);
      assert.equal(view?.coverage, item.partial ? "partial" : "reported", item.name);
      assert.deepEqual(view?.usageDiagnostics?.map(row => [row.code, row.installationId]),
        item.partial ? [["unverified-source-history", source.installationId]] : undefined);
      assert.equal((await migrated.readCheckpoint("workspace", source)).version, 2);
    }
  } finally { await migrated.close(); }
});
