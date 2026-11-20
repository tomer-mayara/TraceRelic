import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexIdentityRepairFixture } from "#collector-fixture/codex-identity-repair-fixture";
import { CollectorApiFixture } from "../../fixtures/collector-api-fixture.ts";

test("the HTTP adapter repairs the verified installation's text and keeps its peer inside the same workspace", async t => {
  const api = await CollectorApiFixture.open();
  t.after(() => api.close());
  const fixture = await CodexIdentityRepairFixture.create(api.client);
  t.after(() => fixture.root.close());
  await fixture.legacy();
  await fixture.scan(["B"]);
  const evidence = await fixture.proof();
  assert.equal((await api.laptop.post("presence", evidence)).status, 400);
  assert.deepEqual(await fixture.texts("A"), ["belongs to B", "belongs to A"]);
  await fixture.scan();
  assert.deepEqual(await fixture.texts("A"), ["belongs to A"]);
  assert.deepEqual(await fixture.texts("B"), ["belongs to B"]);
  assert.equal(await api.b.readSession(fixture.key("B")), null);
});
