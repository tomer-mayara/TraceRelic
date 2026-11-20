import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { StorageUnavailableError } from "@tracerelic/collector/storage";
import { PostgresCollectorDatabase } from "#src/storage/collector-database";
import { migrationVersions, projectedWrite } from "../../fixtures/collector-database-write.ts";
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

test("concurrent startups install one migration and share lossless, workspace-scoped projections", async () => {
  assert.deepEqual(await migrationVersions(postgres.url), [1]);
  const [writer, reader] = databases;
  const { write, view, inventory } = projectedWrite();
  const { checkpoint, source } = write.value;
  const { key } = view;
  const workspace = "one";
  const position = await writer.write(workspace, tx => tx.save(write, [{ version: 1, view }], checkpoint, inventory));
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
    await tx.save(write, [{ version: 1, view }], checkpoint, inventory);
    assert.equal(await reader.readSession("rollback", view.key), null);
    throw new Error("fixture rolled back");
  }));
  assert.equal(await reader.readSession("rollback", view.key), null);
  assert.deepEqual(await reader.readCheckpoint("rollback", source), { checkpoint: null, version: 0 });
  assert.deepEqual(await reader.write("rollback", tx => tx.entriesAfter("0")), []);
  await writer.write("rollback", tx => tx.save(write, [{ version: 1, view }], checkpoint, inventory));
  assert.deepEqual(await reader.readSession("rollback", view.key), view);
});

test("journal readers advance through bounded pages of their workspace in write order", async () => {
  const [database] = databases;
  const { write, view, inventory } = projectedWrite();
  const checkpoint = write.value.checkpoint;
  const save = (workspace: string, version: number) => database.write(workspace,
    tx => tx.save(write, [{ version, view }], checkpoint, inventory));
  const first = await save("paged", 1);
  await save("different", 1);
  const second = await save("paged", 2);
  const third = await save("paged", 3);
  const page = (cursor: string) => database.write("paged", tx => tx.entriesAfter(cursor, 2));
  assert.deepEqual((await page("0")).map(row => row.position), [first, second]);
  assert.deepEqual((await page(second)).map(row => row.position), [third]);
  assert.deepEqual(await page(third), []);
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
