import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeCopyMetadataFixture } from "#collector-fixture/claude-copy-metadata-fixture";
import { DurableParityFixture } from "../../fixtures/durable-parity-fixture.ts";

test("a new PostgreSQL writer preserves accepted Claude backup metadata while upgrading its checkpoint", async t => {
  const db = await DurableParityFixture.open(t);
  const files = await ClaudeCopyMetadataFixture.create();
  t.after(() => files.close());
  await db.compare(async store => { await files.seed(store); });
  const before = await db.compare(store => store.readSession(files.key));
  assert.deepEqual(before?.metadata, { cwd: "/current", repository: "first backup value", branch: "current-branch", parentSessionId: "current-parent" });
  await db.reconnect();
  assert.deepEqual(await db.compare(store => files.scan(store)), [before]);
  await db.reconnect();
  assert.deepEqual(await db.compare(store => files.scan(store)), [before]);
});
