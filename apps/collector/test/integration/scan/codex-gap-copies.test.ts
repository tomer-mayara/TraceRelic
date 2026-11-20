import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexUsageScanFixture } from "../../fixtures/codex-usage-scan-fixture.ts";

for (const first of ["desktop", "laptop"] as const) {
  for (const finer of [false, true]) {
    test(`a reset hidden in one copy preserves the same observed span when ${first} arrives first (finer partition ${finer})`, async t => {
      const fixture = await CodexUsageScanFixture.create();
      t.after(() => fixture.close());
      for (const copy of ["desktop", "laptop"] as const) {
        await fixture.report(copy, 1, 70, 70, "a");
        if (copy === "desktop") await fixture.damage(copy);
        else await fixture.report(copy, 2, 5);
        await fixture.report(copy, 3, 100);
        if (finer && copy === "laptop") await fixture.report(copy, 4, 110, 10, "middle");
        await fixture.report(copy, 5, 120, finer ? 5 : undefined);
      }
      const second = first === "desktop" ? "laptop" : "desktop";
      const before = await fixture.scan(first);
      assert.equal(before.observedTotalTokens, first === "desktop" ? 90 : 185);
      const combined = await fixture.scan(second);
      assert.equal(combined.coverage, "partial");
      assert.equal(combined.observedTotalTokens, 185);
      if (finer) {
        const anonymous = before.usage.find(part => part.kind === "call" && !part.requestId);
        assert(anonymous);
        assert(combined.usage.some(part => part.id === anonymous.id));
        assert(combined.usage.some(part => part.requestId === "middle"));
      }
      assert.deepEqual(await fixture.scan(first), combined);
      assert.deepEqual(await fixture.scan(second), combined);
    });
  }
}

test("the same counter values measured at different provider observations can belong to distinct epochs", async t => {
  const fixture = await CodexUsageScanFixture.create();
  t.after(() => fixture.close());
  for (const copy of ["desktop", "laptop"] as const) {
    await fixture.report(copy, 1, 70, 70, "a");
    if (copy === "desktop") await fixture.damage(copy);
    await fixture.report(copy, 2, 100);
    await fixture.report(copy, 3, 120);
  }
  await fixture.report("laptop", 4, 5);
  await fixture.report("laptop", 5, 100);
  await fixture.report("laptop", 6, 120);
  assert.equal((await fixture.scan("desktop")).observedTotalTokens, 90);
  // The intact copy measured 120 tokens before the reset and 115 after the new baseline.
  assert.equal((await fixture.scan("laptop")).observedTotalTokens, 235);
});

for (const first of ["desktop", "laptop"] as const) {
  test(`an incomplete partition keeps the already measured span when ${first} arrives first`, async t => {
    const fixture = await CodexUsageScanFixture.create();
    t.after(() => fixture.close());
    for (const copy of ["desktop", "laptop"] as const) {
      await fixture.report(copy, 1, 70, 70, "a");
      if (copy === "desktop") await fixture.damage(copy);
      else await fixture.report(copy, 2, 5);
      await fixture.report(copy, 3, 100);
    }
    await fixture.report("desktop", 5, 120);
    await fixture.report("desktop", 6, 130, 10, "outside");
    await fixture.report("laptop", 4, 110, 10, "middle");
    const second = first === "desktop" ? "laptop" : "desktop";
    await fixture.scan(first);
    const partial = await fixture.scan(second);
    assert.equal(partial.observedTotalTokens, first === "desktop" ? 195 : 185);
    assert(partial.usage.some(p => p.requestId === "outside"));
    assert.equal(partial.usage.some(p => p.requestId === "middle"), first === "laptop");
    await fixture.report("laptop", 5, 120);
    const verified = await fixture.scan("laptop");
    assert.equal(verified.observedTotalTokens, 195);
    assert.deepEqual(verified.usage.filter(p => p.requestId).map(p => p.requestId).sort(), ["a", "middle", "outside"]);
  });
}
