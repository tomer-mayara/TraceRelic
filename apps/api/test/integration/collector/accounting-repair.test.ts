import assert from "node:assert/strict";
import { test } from "node:test";
import { accountingRepairFixture } from "#collector-fixture/accounting-repair-fixture";
import { ClaudeForkScanFixture } from "#collector-fixture/claude-fork-scan-fixture";
import { CodexForkScanFixture } from "#collector-fixture/codex-fork-scan-fixture";
import { DurableParityFixture } from "../../fixtures/durable-parity-fixture.ts";

test("memory and PostgreSQL repair materialized legacy usage from the accepted source once, including after reconnect", async t => {
  const stores = await DurableParityFixture.open(t);
  const cases = [
    { example: "codex", before: 20, coverage: "partial", after: 10 },
    { example: "claude", before: 22, coverage: "reported", after: 16 },
    { example: "native-codex", before: null, coverage: "unknown", after: 120 },
  ] as const;
  for (const { example, before, coverage, after } of cases) {
    const f = await accountingRepairFixture(example); t.after(() => f.close());
    const source = f.legacy.source;
    await stores.commit(f.legacy, example);
    const old = await stores.compare(store => store.readSession(source), example);
    assert(old);
    assert.equal(old.observedTotalTokens, before);
    assert.equal(old.coverage, coverage);
    await stores.reconnect();
    const fixed = await stores.compare(f.scan, example);
    assert.equal(fixed.observedTotalTokens, after);
    assert.equal(fixed.coverage, "reported");
    if (old.usage.length) assert.equal(fixed.usage[0].id, old.usage[0].id);
    if (example === "native-codex") assert.equal(fixed.usage[0].responseId, "response");
    if (example === "claude") {
      assert.equal(fixed.usage[1].id, old.usage[1].id);
      assert.equal(fixed.usage[1].iterationId, "native:advisor-a");
    }
    const checkpoint = await stores.compare(store => store.readCheckpoint(source), example);
    assert.equal(checkpoint.checkpoint?.evidenceVersion, 1);
    await stores.reconnect();
    assert.deepEqual(await stores.compare(f.scan, example), fixed);
    assert.deepEqual(await stores.compare(store => store.readCheckpoint(source), example), checkpoint);
  }
});

test("durable fork attribution survives reordered discovery, a shorter parent and a copied final with a new advisor", async t => {
  const stores = await DurableParityFixture.open(t);
  for (const site of ["parent", "child"] as const) {
    const codex = await CodexForkScanFixture.create(site); t.after(() => codex.close());
    await codex.writeParent(200, 260);
    await codex.writeChild(200, 225);
    await stores.compare(store => codex.scanWith(store), site);
    await stores.reconnect();
    await codex.shortenParent(site === "parent");
    const views = await stores.compare(store => codex.scanWith(store), site);
    assert.equal(views.find(row => row.key.sessionId === "child")?.observedTotalTokens, 25);
    assert.deepEqual(await stores.compare(store => codex.scanWith(store), site), views);

    const claude = await ClaudeForkScanFixture.create("fork"); t.after(() => claude.close());
    await claude.writeParent(100, { provisional: true });
    await claude.writeCopy(80, { advisorTokens: 30 });
    await claude.appendOwn(25);
    await stores.compare(store => claude.scan(site, store), site);
    await stores.reconnect();
    await stores.compare(store => claude.scan(site === "parent" ? "child" : "parent", store), site);
    const parent = await stores.compare(store => store.readSession(claude.parent), site);
    assert.equal(parent?.observedTotalTokens, 110);
    assert.equal((await stores.compare(store => store.readSession(claude.child), site))?.observedTotalTokens, 25);
    await stores.reconnect();
    await stores.compare(store => claude.scan("parent", store), site);
    assert.deepEqual(await stores.compare(store => store.readSession(claude.parent), site), parent);
  }
});
