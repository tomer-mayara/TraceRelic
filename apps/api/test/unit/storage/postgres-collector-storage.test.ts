import assert from "node:assert/strict";
import { test } from "node:test";
import { StorageUnavailableError } from "@tracerelic/collector/storage";
import { SessionVersionConflict } from "#src/storage/collector-database";
import { PostgresCollectorStorage } from "#src/storage/postgres-collector-storage";
import { CollectorTransactionFixture, revision } from "../../fixtures/collector-transaction-fixture.ts";
import { batch, key, presence, scope, session, source, storedSource } from "../../fixtures/collector-wire-payloads.ts";

test("reads select the workspace in the database without loading the writer's journal", async () => {
  const db = new CollectorTransactionFixture();
  const store = new PostgresCollectorStorage(db, "workspace");
  assert.deepEqual(await store.readSession(key), session);
  assert.deepEqual(await store.readCheckpoint(source), { version: 1, checkpoint: batch.checkpoint });
  assert.deepEqual(await store.listSources(scope), [storedSource]);
  assert.deepEqual(db.readSession.mock.calls[0].arguments, ["workspace", key]);
  assert.deepEqual(db.readCheckpoint.mock.calls[0].arguments, ["workspace", source]);
  assert.deepEqual(db.listSources.mock.calls[0].arguments, ["workspace", scope]);
  assert.deepEqual(db.cursors, []);
});

test("a warm writer applies intervening writes from another connection and skips a repeated presence report", async () => {
  const db = new CollectorTransactionFixture();
  const one = new PostgresCollectorStorage(db, "workspace");
  const two = new PostgresCollectorStorage(db, "workspace");
  assert.equal(await one.commit(batch), "committed");
  assert.equal(await two.recordPresence(presence), "committed");
  assert.equal(await one.recordPresence({ ...presence, expectedVersion: 2 }), "committed");
  assert.equal(await one.commit(batch), "conflict");
  const next = { ...revision(1), expectedVersion: 2 };
  assert.equal(await one.commit({ ...next, messages: [{ ...batch.messages[0], text: "conflicting message" }] }), "invalid");
  assert.equal(await one.commit(next), "committed");
  assert.deepEqual(db.cursors, ["0", "0", "1", "2", "2", "2"]);
  assert.deepEqual(db.saved.map(row => row.write.kind), ["batch", "presence", "batch"]);
  assert.deepEqual(db.saved.map(row => row.sessions.map(({ version }) => version)), [[1], [2], [3]]);
  assert.equal(db.saved[1].inventory?.presence, "missing");
  assert.equal(db.saved[2].inventory?.presence, "present");
  assert.deepEqual(db.saved[2].sessions[0].messages, { upserts: [], removed: [] });
  assert.deepEqual(db.saved[2].sessions[0].usage.upserts, [{ ordinal: 1, record: next.usage[0] }]);
});

test("a cold writer replays a long journal in bounded pages before applying the next correction", async () => {
  const db = new CollectorTransactionFixture();
  const original = new PostgresCollectorStorage(db, "workspace");
  for (let i = 0; i < 130; i++) assert.equal(await original.commit(revision(i)), "committed");
  db.cursors.length = 0;
  const restarted = new PostgresCollectorStorage(db, "workspace");
  const next = revision(130);
  assert.equal(await restarted.commit(next), "committed");
  assert.equal(db.cursors[0], "0");
  assert(db.cursors.length > 1, "cold recovery must fetch the accepted writes in pages");
  assert.deepEqual(db.saved[130].sessions[0].usage.upserts, [{ ordinal: 1, record: next.usage[0] }]);
});

for (const failure of ["rollback", "lost-reply"] as const) {
  test(`a ${failure} during commit reloads the database before the next local write`, async () => {
    const db = new CollectorTransactionFixture();
    const store = new PostgresCollectorStorage(db, "workspace");
    assert.equal(await store.commit(batch), "committed");
    const next = revision(1);
    db.failure = failure;
    await assert.rejects(store.commit(next), StorageUnavailableError);
    assert.equal(db.saved.length, failure === "rollback" ? 1 : 2);
    assert.equal(await store.commit(next), failure === "rollback" ? "committed" : "conflict");
    assert.deepEqual(db.cursors, ["0", "1", "0"]);
    assert.equal(db.saved.length, 2);
    assert.equal(await store.commit(revision(2)), "committed");
    assert.equal(db.saved[2].sessions[0].version, 3);
    assert.deepEqual(db.saved[2].sessions[0].messages, { upserts: [], removed: [] });
  });
}

test("a database version conflict discards the writer's uncommitted state before a retry", async () => {
  const db = new CollectorTransactionFixture();
  const store = new PostgresCollectorStorage(db, "workspace");
  assert.equal(await store.commit(batch), "committed");
  const next = revision(1);
  db.beforeCommit = async () => { throw new SessionVersionConflict(); };
  assert.equal(await store.commit(next), "conflict");
  assert.equal(db.saved.length, 1);
  db.beforeCommit = undefined;
  assert.equal(await store.commit(next), "committed");
  assert.deepEqual(db.cursors, ["0", "1", "0"]);
  assert.equal(db.saved[1].sessions[0].version, 2);
});

test("an overlapping local write waits for an unconfirmed transaction", async () => {
  const db = new CollectorTransactionFixture();
  const store = new PostgresCollectorStorage(db, "workspace");
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  db.beforeCommit = async () => { started.resolve(); await finish.promise; };
  db.failure = "rollback";
  const first = assert.rejects(store.commit(batch), StorageUnavailableError);
  await started.promise;
  const second = store.commit(batch);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(db.cursors, ["0"]);
  finish.resolve();
  await first;
  assert.equal(await second, "committed");
  assert.equal(db.saved.length, 1);
});

test("inserting a message earlier changes its and the shifted message's ordinals only", async () => {
  const db = new CollectorTransactionFixture();
  const store = new PostgresCollectorStorage(db, "ordered");
  const later = { ...batch.messages[0], sourceOrder: 2 };
  const earlier = { ...batch.messages[0], id: "earlier" };
  assert.equal(await store.commit({ ...batch, messages: [later] }), "committed");
  assert.equal(await store.commit({ ...revision(1), messages: [earlier], usage: [] }), "committed");
  assert.deepEqual(db.saved[1].sessions[0].messages.upserts,
    [{ ordinal: 1, record: earlier }, { ordinal: 2, record: later }]);
  assert.deepEqual(db.saved[1].sessions[0].usage, { upserts: [], removed: [] });
});
