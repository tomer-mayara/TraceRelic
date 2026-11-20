import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexIdentityRepairFixture } from "#collector-fixture/codex-identity-repair-fixture";
import { CodexIdentityDatabase } from "../../fixtures/codex-identity-database.ts";

test("journal, versions, source proof and both views survive rollback and restart together", async t => {
  const database = await CodexIdentityDatabase.open();
  t.after(() => database.close());
  let storage = database.storage();
  const fixture = await CodexIdentityRepairFixture.create(storage);
  t.after(() => fixture.root.close());
  await fixture.legacy();
  await fixture.scan(["B"]);
  const proof = await fixture.proof();
  const read = () => Promise.all(["A", "B"].map(async id => {
    const key = fixture.key(id);
    return { version: (await storage.readCheckpoint(key)).version, messages: (await storage.readSession(key))?.messages.map(row => row.text) };
  }));
  const before = await read();
  await assert.rejects(database.failAtCommit(() => storage.recordPresence(proof)), /Collector database operation failed/);
  await database.reconnect();
  storage = database.storage();
  assert.deepEqual(await read(), before);
  assert.equal(await storage.recordPresence(proof), "committed");
  await database.reconnect();
  storage = database.storage();
  assert.deepEqual(await read(), [{ version: before[0].version + 1, messages: ["belongs to A"] },
    { version: before[1].version + 1, messages: ["belongs to B"] }]);
  assert.equal(await storage.recordPresence(proof), "conflict");
  const [row] = await storage.listSources({ harness: "codex", root: fixture.root.home, installationId: "desktop", sessionIds: ["A"] });
  assert.equal(row.codexIdentityStatus, "repaired");
});
