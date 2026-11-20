import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresCollectorDatabase } from "#src/storage/collector-database";
import { PostgresCollectorStorage } from "#src/storage/postgres-collector-storage";
import { DisposablePostgres } from "../../fixtures/disposable-postgres.ts";
import { failCheckpointWrites, lc17Journal, seedLc17 } from "../../fixtures/legacy-journal.ts";

for (const followupStored of [true, false]) {
  test(`LC-17 copied advisor remains at its accepted owner until a verified repair (old parent append ${followupStored ? "stored" : "pending"})`, async t => {
    const pg = await DisposablePostgres.open();
    t.after(() => pg.close());
    const entries = await lc17Journal("claude");
    await seedLc17(pg.url, entries.slice(0, followupStored ? 3 : 2));
    const db = await PostgresCollectorDatabase.open(pg.url);
    t.after(() => db.close());
    const [parent, child, appended] = entries.map(row => row.write.value);
    const store = new PostgresCollectorStorage(db, "legacy");
    const other = { ...parent, source: { ...parent.source, sessionId: "independent" }, claudeUsageReports: [], messages: [] };
    assert.equal(await store.commit(other), "committed");
    assert.equal((await store.readCheckpoint(parent.source)).version, followupStored ? 2 : 1);
    assert.equal((await store.readCheckpoint(child.source)).version, 1);
    assert.equal((await store.readSession(parent.source))?.observedTotalTokens, 100);
    assert.equal((await store.readSession(child.source))?.observedTotalTokens, 25);
    if (!followupStored) assert.equal(await store.commit(appended), "committed");

    const repair = { ...child, expectedVersion: 1, expectedOffset: child.checkpoint.offset,
      checkpoint: { ...child.checkpoint, evidenceVersion: 1 as const }, repairEvidenceFrom: child.checkpoint };
    const fresh = new PostgresCollectorStorage(db, "legacy");
    assert.equal(await fresh.commit({ ...repair, expectedVersion: 0 }), "conflict");
    await failCheckpointWrites(pg.url, true);
    await assert.rejects(fresh.commit(repair));
    await failCheckpointWrites(pg.url, false);
    assert.equal((await store.readSession(parent.source))?.observedTotalTokens, 100);
    assert.equal((await store.readCheckpoint(parent.source)).version, 2);
    assert.equal((await store.readCheckpoint(child.source)).version, 1);
    assert.equal(await fresh.commit(repair), "committed");
    assert.equal((await store.readSession(parent.source))?.observedTotalTokens, 130);
    assert.deepEqual((await store.readSession(parent.source))?.messages, appended.messages);
    assert.equal((await store.readSession(child.source))?.observedTotalTokens, 25);
    assert.equal((await store.readCheckpoint(parent.source)).version, 3);
    assert.equal((await store.readCheckpoint(child.source)).version, 2);
    const restarted = new PostgresCollectorStorage(db, "legacy");
    assert.equal(await restarted.commit(repair), "conflict");
    assert(appended.sourceObservation);
    assert.equal(await restarted.commit({ ...appended, expectedVersion: 3, expectedOffset: appended.checkpoint.offset,
      checkpoint: { ...appended.checkpoint, offset: 30 }, sourceObservation: { ...appended.sourceObservation, observedEnd: 30 }, messages: [] }), "committed");
    assert.equal((await restarted.readSession(parent.source))?.observedTotalTokens, 130);
  });
}

test("LC-17 Codex fork corrections keep both sibling versions and their accepted raw ownership decisions", async t => {
  const pg = await DisposablePostgres.open();
  t.after(() => pg.close());
  const entries = await lc17Journal("codex");
  await seedLc17(pg.url, entries);
  const db = await PostgresCollectorDatabase.open(pg.url);
  t.after(() => db.close());
  const store = new PostgresCollectorStorage(db, "legacy");
  const [child, sibling, parent] = entries.map(row => row.write.value);
  const other = { ...parent, source: { ...parent.source, sessionId: "unrelated" } };
  assert.equal(await store.commit(other), "committed");
  for (const source of [child.source, sibling.source]) {
    assert.equal((await store.readCheckpoint(source)).version, 2);
    assert.equal((await store.readSession(source))?.observedTotalTokens, null);
  }
});

test("a verified Codex source repair withdraws an old claim and publishes the sibling's retained measurement", async t => {
  const pg = await DisposablePostgres.open();
  t.after(() => pg.close());
  const entries = await lc17Journal("codex");
  await seedLc17(pg.url, entries.slice(0, 4));
  const db = await PostgresCollectorDatabase.open(pg.url);
  t.after(() => db.close());
  const store = new PostgresCollectorStorage(db, "legacy");
  const sibling = entries[1].write.value.source;
  const { reconcileCodexForkFrom: _, ...corrected } = entries[3].write.value;
  assert.equal((await store.readSession(sibling))?.observedTotalTokens, null);
  assert.equal((await store.readCheckpoint(sibling)).version, 1);
  assert.equal(await store.commit({ ...corrected, expectedVersion: 2, checkpoint: { ...corrected.checkpoint, evidenceVersion: 1 },
    repairEvidenceFrom: corrected.checkpoint }), "committed");
  assert.equal((await store.readSession(sibling))?.observedTotalTokens, 10);
  assert.equal((await store.readCheckpoint(sibling)).version, 2);
  assert.equal((await store.readSession(corrected.source))?.observedTotalTokens, null);
  assert.equal((await store.readCheckpoint(corrected.source)).version, 3);
  const fresh = new PostgresCollectorStorage(db, "legacy");
  assert.equal(await fresh.commit(entries[4].write.value), "conflict");
  assert.equal(await fresh.commit({ ...entries[4].write.value, expectedVersion: 2 }), "committed");
  assert.equal((await fresh.readSession(sibling))?.observedTotalTokens, null);
});

test("a legacy Claude append keeps its source's policy and newly accepted replacement evidence uses its own generation", async t => {
  const pg = await DisposablePostgres.open();
  t.after(() => pg.close());
  const entries = await lc17Journal("claude");
  await seedLc17(pg.url, entries.slice(0, 2));
  const db = await PostgresCollectorDatabase.open(pg.url);
  t.after(() => db.close());
  const store = new PostgresCollectorStorage(db, "legacy");
  const [parent, child] = entries.map(entry => entry.write.value);
  assert(child.sourceObservation);
  const checkpoint = { ...child.checkpoint, offset: 20 };
  assert.equal(await store.commit({ ...child, expectedVersion: 1, expectedOffset: 10, checkpoint,
    sourceObservation: { ...child.sourceObservation, observedEnd: 20 } }), "committed");
  assert.equal((await store.readSession(parent.source))?.observedTotalTokens, 100);
  assert.equal((await store.readCheckpoint(parent.source)).version, 1);
  const fresh = new PostgresCollectorStorage(db, "legacy");
  assert.equal(await fresh.commit({ ...child, expectedVersion: 2, expectedOffset: 20, resetFrom: checkpoint,
    checkpoint: { ...child.checkpoint, prefixDigest: "d".repeat(64) } }), "committed");
  assert.equal((await fresh.readSession(parent.source))?.observedTotalTokens, 130);
  assert.equal((await fresh.readCheckpoint(parent.source)).version, 2);
  assert.equal((await fresh.readSession(child.source))?.observedTotalTokens, 25);
});

for (const name of ["claude-reset", "codex-recovery"] as const) {
  test(`a cold presence write preserves the LC-17 recorded usage and coverage for ${name}`, async t => {
    const pg = await DisposablePostgres.open();
    t.after(() => pg.close());
    const entries = await lc17Journal(name);
    await seedLc17(pg.url, entries);
    const db = await PostgresCollectorDatabase.open(pg.url);
    t.after(() => db.close());
    const store = new PostgresCollectorStorage(db, "legacy");
    const last = entries.at(-1);
    assert(last?.inventory);
    const { view, version } = last.changed[0];
    const { source, location, acceptedOffset, observedEnd } = last.inventory;
    assert.deepEqual(await store.readSession(source), view);
    assert.equal(await store.recordPresence({ source, presence: "present", expectedVersion: version, expectedOffset: acceptedOffset,
      observedEnd, location: { ...location, cwd: "/observed/worktree" } }), "committed");
    assert.equal((await store.readCheckpoint(source)).version, version + 1);
    assert.deepEqual(await store.readSession(source), view);
  });
}

test("an old Codex fork's reported uncertainty survives an unversioned correction until a verified repair", async t => {
  const pg = await DisposablePostgres.open();
  t.after(() => pg.close());
  const entries = await lc17Journal("codex");
  const first = entries[0], revoked = entries[3];
  await seedLc17(pg.url, [first, revoked]);
  const db = await PostgresCollectorDatabase.open(pg.url);
  t.after(() => db.close());
  const store = new PostgresCollectorStorage(db, "legacy");
  const batch = first.write.value, before = revoked.write.value.checkpoint;
  assert.equal(await store.commit({ ...batch, expectedVersion: 2, expectedOffset: before.offset, reconcileCodexForkFrom: before }), "committed");
  const preserved = await store.readSession(batch.source);
  assert.equal(preserved?.observedTotalTokens, 10);
  assert.equal(preserved.coverage, "partial");
  assert.deepEqual(preserved.usageDiagnostics, revoked.changed[0].view.usageDiagnostics);
  const fresh = new PostgresCollectorStorage(db, "legacy");
  assert.equal(await fresh.commit({ ...batch, expectedVersion: 3, expectedOffset: before.offset, repairEvidenceFrom: batch.checkpoint,
    checkpoint: { ...batch.checkpoint, evidenceVersion: 1 } }), "committed");
  const verified = await fresh.readSession(batch.source);
  assert.equal(verified?.coverage, "reported");
  assert.equal(verified.observedTotalTokens, 10);
  assert.equal(verified.usageDiagnostics, undefined);
});
