import assert from "node:assert/strict";
import { test } from "node:test";
import type { Batch, SessionView } from "../../../src/storage/collector-storage.ts";
import { CodexUsageScanFixture } from "../../fixtures/codex-usage-scan-fixture.ts";

function checkCoarse(view: SessionView) {
  assert.equal(view.observedTotalTokens, 200);
  assert.deepEqual(view.usage.map(row => [row.kind, row.inputTokens, row.outputTokens]), [["interval", 160, 40]]);
}

function checkParts(view: SessionView) {
  assert.equal(view.observedTotalTokens, 200);
  assert.equal(view.coverage, "reported");
  assert.deepEqual(view.usage.map(row => [row.requestId, row.kind, row.inputTokens, row.outputTokens]).sort(), [
    ["first", "call", 96, 24], ["second", "call", 64, 16],
  ]);
}

for (const first of ["desktop", "laptop"] as const) {
  test(`coarse and detailed copies converge when ${first} commits first`, async t => {
    const fixture = await CodexUsageScanFixture.create();
    t.after(() => fixture.close());
    await fixture.report("desktop", 2, 200);
    await fixture.report("laptop", 1, 120, 120, "first");
    await fixture.report("laptop", 2, 200, 80, "second");
    const initial = await fixture.scan(first);
    if (first === "desktop") checkCoarse(initial);
    else checkParts(initial);
    const second = first === "desktop" ? "laptop" : "desktop";
    const final = await fixture.scan(second);
    checkParts(final);
    assert.deepEqual(await fixture.scan(first), final);
    assert.deepEqual(await fixture.scan(second), final);
  });
}

test("a fine partition received in two scans replaces the coarse interval only when complete", async t => {
  const fixture = await CodexUsageScanFixture.create();
  t.after(() => fixture.close());
  await fixture.report("desktop", 2, 200);
  const coarse = await fixture.scan("desktop");
  checkCoarse(coarse);
  await fixture.report("laptop", 1, 120, 120, "first");
  const partial = await fixture.scan("laptop");
  assert.deepEqual(partial.usage, coarse.usage);
  assert.equal(partial.observedTotalTokens, 200);
  const pending = await fixture.checkpoint("laptop");
  assert(pending.checkpoint);
  await fixture.report("laptop", 2, 200, 80, "second");
  checkParts(await fixture.scan("laptop"));
  const final = await fixture.checkpoint("laptop");
  assert(final.checkpoint && final.checkpoint.offset > pending.checkpoint.offset);
});

for (const failure of ["invalid", "conflict"] as const) {
  test(`a rejected replacement (${failure}) keeps the accepted interval and can be retried`, async t => {
    const fixture = await CodexUsageScanFixture.create();
    t.after(() => fixture.close());
    await fixture.report("desktop", 2, 200);
    const coarse = await fixture.scan("desktop");
    checkCoarse(coarse);
    await fixture.report("laptop", 1, 120, 120, "first");
    await fixture.scan("laptop");
    const before = await fixture.checkpoint("laptop");
    assert(before.checkpoint);
    await fixture.report("laptop", 2, 200, 80, "second");

    const commit = fixture.storage.commit.bind(fixture.storage);
    const injectFailure = t.mock.method(fixture.storage, "commit", async (batch: Batch) => {
      if (batch.source.installationId === "desktop") return commit(batch);
      if (failure === "conflict") {
        // Advance the shared session version after the laptop has read its checkpoint.
        await fixture.report("desktop", 3, 200);
        await fixture.scan("desktop");
        return commit(batch);
      }
      assert(batch.usageWindows?.length);
      const windows = batch.usageWindows.map(window => ({
        ...window, end: { ...window.end, outputTokens: window.end.outputTokens + 1 },
      }));
      return commit({ ...batch, usageWindows: windows });
    });
    await assert.rejects(fixture.scan("laptop"), new RegExp("Storage returned " + failure));
    injectFailure.mock.restore();
    const after = await fixture.checkpoint("laptop");
    assert.deepEqual(after.checkpoint, before.checkpoint);
    assert.equal(after.version, before.version + (failure === "conflict" ? 1 : 0));
    const accepted = await fixture.storage.readSession(fixture.key);
    assert(accepted);
    assert.deepEqual(accepted.usage, coarse.usage);
    assert.equal(accepted.observedTotalTokens, 200);
    checkParts(await fixture.scan("laptop"));
  });
}

test("a last-only call inside an accepted interval waits for the rest of the partition", async t => {
  const fixture = await CodexUsageScanFixture.create();
  t.after(() => fixture.close());
  await fixture.report("desktop", 3, 200);
  const coarse = await fixture.scan("desktop");
  checkCoarse(coarse);

  await fixture.report("laptop", 1, 120);
  checkCoarse(await fixture.scan("laptop"));
  await fixture.report("laptop", 2, undefined, 20, "early");
  for (const id of ["laptop", "desktop"] as const) {
    const pending = await fixture.scan(id);
    assert.equal(pending.observedTotalTokens, 200);
    assert.deepEqual(pending.usage, coarse.usage);
  }

  await fixture.report("laptop", 3, 200, 30, "last");
  const final = await fixture.scan("laptop");
  assert.equal(final.observedTotalTokens, 200);
  assert.equal(final.coverage, "reported");
  assert.deepEqual(final.usage.map(row => [row.kind, row.requestId, row.inputTokens, row.outputTokens]).sort(), [
    ["call", "early", 16, 4], ["call", "last", 24, 6], ["interval", undefined, 24, 6], ["interval", undefined, 96, 24],
  ]);
  assert.deepEqual(await fixture.scan("desktop"), final);
  assert.deepEqual(await fixture.scan("laptop"), final);
});
