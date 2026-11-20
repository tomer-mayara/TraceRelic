import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexIdentityRepairFixture } from "../../fixtures/codex-identity-repair-fixture.ts";
import { StorageUnavailableError, type PresenceWrite } from "#src/storage/collector-storage";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";

for (const match of ["verified", "wrong digest", "absent digest", "wrong row", "unverified usage"] as const) {
  test("legacy cross-session Codex evidence: " + match, async t => {
    const fixture = await CodexIdentityRepairFixture.create();
    t.after(() => fixture.root.close());
    await fixture.legacy({ digest: match === "wrong digest" ? "wrong" : match === "absent digest" ? "absent" : undefined,
      wrongText: match === "wrong row", usage: match === "unverified usage" });
    await fixture.scan(["A"]);
    assert.equal(await fixture.texts("B"), undefined);
    const [uncertain] = await fixture.scan(["A"]);
    assert(uncertain?.usageDiagnostics?.some(row => row.code === "unverified-source-history"));
    await fixture.scan();
    const repaired = match === "verified" || match === "unverified usage";
    assert.deepEqual(await fixture.texts("A"), repaired ? ["belongs to A"] : [match === "wrong row" ? "uncertain" : "belongs to B", "belongs to A"]);
    assert.deepEqual(await fixture.texts("B"), ["belongs to B"]);
    const key = fixture.key("A");
    const view = await fixture.storage.readSession(key);
    assert.equal(view?.usageDiagnostics?.some(row => row.code === "unverified-source-history") ?? false, match !== "verified");
    if (match === "unverified usage") assert.equal(view?.coverage, "partial");
    const checkpoints = () => Promise.all(["A", "B"].map(id => fixture.storage.readCheckpoint(fixture.key(id))));
    const stable = await checkpoints();
    await fixture.scan();
    assert.deepEqual(await checkpoints(), stable);
  });
}

test("a stale peer cannot retract text and a lost repair reply is recovered from inventory", async t => {
  const storage = new InMemoryCollectorStorage();
  const fixture = await CodexIdentityRepairFixture.create(storage);
  t.after(() => fixture.root.close());
  await fixture.legacy();
  await fixture.scan(["B"]);
  const update = await fixture.proof();
  const proof = update.codexIdentity;
  assert(proof?.status === "verified");
  assert.equal(await storage.recordPresence({ ...update, codexIdentity: { ...proof, expectedPeerVersion: proof.expectedPeerVersion - 1 } }), "conflict");
  assert.equal(await storage.recordPresence({ ...update, codexIdentity: { ...proof, accepted: { offset: update.expectedOffset, prefixDigest: "0".repeat(64) } } }), "invalid");
  assert.deepEqual(await fixture.texts("A"), ["belongs to B", "belongs to A"]);
  const record = storage.recordPresence.bind(storage);
  let lost = false;
  t.mock.method(storage, "recordPresence", async (write: PresenceWrite) => {
    const result = await record(write);
    if (!lost && write.codexIdentity?.status === "verified") {
      lost = true;
      throw new StorageUnavailableError("lost repair reply");
    }
    return result;
  });
  await fixture.scan();
  assert.equal(lost, true);
  assert.deepEqual(await fixture.texts("A"), ["belongs to A"]);
  assert.deepEqual(await fixture.texts("B"), ["belongs to B"]);
});
