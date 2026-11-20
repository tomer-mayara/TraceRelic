import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { StorageUnavailableError } from "@tracerelic/collector/storage";
import { PostgresCollectorDatabase, SessionVersionConflict } from "#src/storage/collector-database";
import { fullProjection, migrationVersions, projectedWrite } from "../../fixtures/collector-database-write.ts";
import { PostgresCollectorStorage } from "#src/storage/postgres-collector-storage";
import { DisposablePostgres } from "../../fixtures/disposable-postgres.ts";

let postgres: DisposablePostgres;
let databases: PostgresCollectorDatabase[] = [];

before(async () => {
  postgres = await DisposablePostgres.open();
  databases = await Promise.all([PostgresCollectorDatabase.open(postgres.url), PostgresCollectorDatabase.open(postgres.url)]);
});
after(async () => {
  await Promise.all(databases.map(database => database.close()));
  await postgres?.close();
});

test("concurrent startups apply the wire and storage migrations once and share lossless, workspace-scoped projections", async () => {
  assert.deepEqual(await migrationVersions(postgres.url), [1, 2, 3]);
  const [writer, reader] = databases;
  const { write, view, inventory } = projectedWrite();
  const { checkpoint, source } = write.value;
  const { key } = view;
  const workspace = "one";
  const position = await writer.write(workspace, tx => tx.save(write, [fullProjection(1, view)], checkpoint, inventory));
  assert.deepEqual(await reader.readSession(workspace, key), view);
  assert.deepEqual(await reader.readSession("other", key), null);
  assert.deepEqual(await reader.readSession(workspace, { ...key, harness: "claude" }), null);
  assert.deepEqual(await reader.readCheckpoint(workspace, source), { checkpoint, version: 1 });
  assert.deepEqual(await reader.readCheckpoint(workspace, { ...source, installationId: undefined }), { checkpoint: null, version: 1 });
  assert.deepEqual(await reader.readCheckpoint("other", source), { checkpoint: null, version: 0 });
  const scope = { harness: key.harness, root: inventory.location.root, installationId: source.installationId };
  assert.deepEqual(await reader.listSources(workspace, scope), [inventory]);
  assert.deepEqual(await reader.listSources(workspace, { ...scope, sessionIds: ["different"] }), []);
  assert.deepEqual(await reader.write(workspace, tx => tx.entriesAfter("0")), [{ position, write }]);
  assert.deepEqual(await reader.write(workspace, tx => tx.entriesAfter(position)), []);
  assert.deepEqual(await reader.write("other", tx => tx.entriesAfter("0")), []);
});

test("a failed transaction leaves the journal, session, records and checkpoint at the last committed state", async () => {
  const [writer, reader] = databases;
  const { write, view, inventory } = projectedWrite();
  const { checkpoint, source } = write.value;
  await assert.rejects(writer.write("rollback", async tx => {
    await tx.save(write, [fullProjection(1, view)], checkpoint, inventory);
    assert.equal(await reader.readSession("rollback", view.key), null);
    throw new Error("fixture rolled back");
  }));
  assert.equal(await reader.readSession("rollback", view.key), null);
  assert.deepEqual(await reader.readCheckpoint("rollback", source), { checkpoint: null, version: 0 });
  assert.deepEqual(await reader.write("rollback", tx => tx.entriesAfter("0")), []);
  await writer.write("rollback", tx => tx.save(write, [fullProjection(1, view)], checkpoint, inventory));
  assert.deepEqual(await reader.readSession("rollback", view.key), view);
});

test("journal readers advance through bounded pages of their workspace in write order", async () => {
  const [database] = databases;
  const first = await database.write("paged", projectedWrite(0).save);
  await database.write("different", projectedWrite(0).save);
  const second = await database.write("paged", projectedWrite(1).save);
  const third = await database.write("paged", projectedWrite(2).save);
  const page = (cursor: string) => database.write("paged", tx => tx.entriesAfter(cursor, 2));
  assert.deepEqual((await page("0")).map(row => row.position), [first, second]);
  assert.deepEqual((await page(second)).map(row => row.position), [third]);
  assert.deepEqual(await page(third), []);
});

test("competing writes to a new session store only the winning journal entry and records", async () => {
  const workspace = "first insert";
  const candidates = [projectedWrite(0, "chat", "one"), projectedWrite(0, "chat", "two")];
  const results = await Promise.allSettled(databases.map((db, i) => db.write(workspace, candidates[i].save)));
  assert.deepEqual(results.map(result => result.status).sort(), ["fulfilled", "rejected"]);
  const index = results.findIndex(result => result.status === "fulfilled");
  const loser = results[1 - index];
  assert(loser.status === "rejected" && loser.reason instanceof SessionVersionConflict);
  const winner = candidates[index];
  const reader = databases[1 - index];
  assert.deepEqual(await reader.readSession(workspace, winner.view.key), winner.view);
  assert.deepEqual(await reader.readCheckpoint(workspace, winner.write.value.source), { version: 1, checkpoint: winner.write.value.checkpoint });
  const journal = await reader.write(workspace, tx => tx.entriesAfter("0"));
  assert.deepEqual(journal.map(entry => entry.write), [winner.write]);
});

test("a stale submitter or a missing session cannot advance to the next version", async () => {
  const [writer, reader] = databases;
  const workspace = "compare versions";
  const second = projectedWrite(1, "chat");
  await assert.rejects(writer.write(workspace, second.save), SessionVersionConflict);
  assert.equal(await reader.readSession(workspace, second.view.key), null);
  await writer.write(workspace, projectedWrite(0, "chat").save);
  const position = await writer.write(workspace, second.save);
  const stale = projectedWrite(1, "chat", "stale");
  await assert.rejects(reader.write(workspace, stale.save), SessionVersionConflict);
  await assert.rejects(reader.write(workspace, tx => tx.save(stale.write, [fullProjection(3, stale.view)],
    stale.write.value.checkpoint, stale.inventory)), SessionVersionConflict);
  assert.deepEqual(await reader.readSession(workspace, second.view.key), second.view);
  assert.deepEqual(await reader.readCheckpoint(workspace, second.write.value.source), { version: 2, checkpoint: second.write.value.checkpoint });
  assert.deepEqual(await reader.write(workspace, tx => tx.entriesAfter(position)), []);
});

test("an absent or stale peer rolls back the source's version, records and journal entry", async () => {
  const [writer, reader] = databases;
  const workspace = "peer versions";
  const source = projectedWrite(0, "source");
  const peer = projectedWrite(1, "peer");
  await writer.write(workspace, source.save);
  await writer.write(workspace, projectedWrite(0, "peer").save);
  const position = await writer.write(workspace, peer.save);
  const next = projectedWrite(1, "source", "uncommitted");
  const absent = projectedWrite(0, "absent");
  await assert.rejects(reader.write(workspace, tx => next.save(tx, [fullProjection(1, absent.view)])), SessionVersionConflict);
  await assert.rejects(reader.write(workspace, tx => next.save(tx, [fullProjection(2, peer.view)])), SessionVersionConflict);
  assert.equal(await reader.readSession(workspace, absent.view.key), null);
  assert.deepEqual(await reader.readSession(workspace, source.view.key), source.view);
  assert.deepEqual(await reader.readCheckpoint(workspace, source.write.value.source), { version: 1, checkpoint: source.write.value.checkpoint });
  assert.deepEqual(await reader.readCheckpoint(workspace, peer.write.value.source), { version: 2, checkpoint: peer.write.value.checkpoint });
  assert.deepEqual(await reader.write(workspace, tx => tx.entriesAfter(position)), []);
});

test("malformed connection settings and unavailable connections use safe diagnostics", async () => {
  for (const url of ["", "https://user:private@example.test/", "postgres:private", "postgres://user:private@localhost:bad/db"]) {
    await assert.rejects(PostgresCollectorDatabase.open(url), error => {
      assert(error instanceof Error);
      assert(!error.message.includes("private"));
      return true;
    });
  }
  const closed = await PostgresCollectorDatabase.open(postgres.url);
  await closed.close();
  await assert.rejects(closed.readSession("one", projectedWrite().view.key), StorageUnavailableError);
  const missingDatabase = new URL(postgres.url);
  missingDatabase.pathname += "_unavailable";
  await assert.rejects(PostgresCollectorDatabase.open(missingDatabase.href), StorageUnavailableError);
});

test("a cold write corrects the database's actual projection when a past reducer stored different records", async () => {
  const [writer, reader] = databases;
  const { write, view, inventory } = projectedWrite(0, "old rows", "retained");
  const first = view.messages[0];
  const oldMessage = { ...first, id: "old shape" };
  const oldUsage = { ...view.usage[0], id: "retired call" };
  const oldView = { ...view, messages: [oldMessage, { ...first, text: "old text" }], usage: [oldUsage] };
  await writer.write("upgrade", tx => tx.save(write, [fullProjection(1, oldView)], write.value.checkpoint, inventory));
  const store = new PostgresCollectorStorage(reader, "upgrade");
  const next = { ...write.value, checkpoint: { ...write.value.checkpoint, offset: 101 }, expectedOffset: 100, expectedVersion: 1,
    sourceObservation: { ...write.value.sourceObservation, observedEnd: 101 }, messages: [], usage: [] };
  assert.equal(await store.commit(next), "committed");
  assert.deepEqual(await reader.readSession("upgrade", view.key), view);
});
