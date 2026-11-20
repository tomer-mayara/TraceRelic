import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeForkScanFixture } from "../../fixtures/claude-fork-scan-fixture.ts";

for (const originalUuid of ["original-row", "absent-row"]) {
  test(`a parent-only scan checks the claimed original ${originalUuid} after the child file is gone`, async t => {
    const f = await ClaudeForkScanFixture.create("fork");
    t.after(() => f.close());
    const byteRange = await f.writeCopy(100, { originalUuid, withPrompt: true });
    await f.appendOwn();
    await f.scan("child");

    const before = await f.storage.readSession(f.child);
    assert(before);
    assert.equal(before.metadata.parentSessionId, "parent");
    assert.equal(before.observedTotalTokens, 25);
    assert.equal(before.coverage, "partial");
    assert.deepEqual(before.messages.map(m => m.text), ["Review café", "Inherited answer", "Child answer"]);
    assert.deepEqual(before.usage.map(row => row.requestId), ["child-request-helper"]);
    assert.deepEqual(before.usageDiagnostics, [{
      code: "unresolved-claude-fork", sourceOrder: 2, byteRange,
      streamId: f.child.streamId, installationId: f.child.installationId,
    }]);
    const checkpoint = await f.storage.readCheckpoint(f.child);
    await f.scan("child");
    assert.deepEqual(await f.storage.readSession(f.child), before);
    assert.deepEqual(await f.storage.readCheckpoint(f.child), checkpoint);

    await rm(join(f.roots.child.home, f.child.streamId));
    await f.writeParent();
    await f.scan("parent");
    const result = await f.snapshot();
    assert.equal(result.parent.observedTotalTokens, 100);
    assert.deepEqual(result.parent.usage.map(row => row.requestId), ["parent-request"]);
    assert.deepEqual(result.child.messages, before.messages);
    assert.deepEqual(result.child.usage, before.usage);
    assert.equal(result.child.observedTotalTokens, 25);
    if (originalUuid === "original-row") {
      assert.equal(result.child.coverage, "reported");
      assert.deepEqual(result.child.usageDiagnostics ?? [], []);
      assert(result.childCheckpoint.version > checkpoint.version);
      assert.deepEqual(result.childCheckpoint.checkpoint, checkpoint.checkpoint);
    } else {
      assert.deepEqual(result.child, before);
      assert.deepEqual(result.childCheckpoint, checkpoint);
    }
    await f.scan("parent");
    assert.deepEqual(await f.snapshot(), result);
  });
}

test("two subagents keep their own requests when they share one model message ID with their parent", async t => {
  const f = await ClaudeForkScanFixture.create("subagent");
  t.after(() => f.close());
  await f.writeParent();
  for (const agent of ["helper", "reviewer"]) {
    await f.writeCopy(100, { agent });
    await f.appendOwn(25, "parent-message", agent);
  }
  await f.scan("child");
  await f.scan("parent");
  const initial = await f.snapshot();
  assert.equal(initial.parent.observedTotalTokens, 100);
  for (const agent of ["helper", "reviewer"]) {
    const source = f.childSource(agent);
    const view = await f.storage.readSession(source);
    assert(view);
    assert.equal(view.metadata.parentSessionId, "parent");
    assert.equal(view.coverage, "reported");
    assert.deepEqual(view.messages.map(row => row.text), ["Inherited answer", "Child answer"]);
    assert.deepEqual(view.usage.map(row => [row.requestId, row.messageId]), [["child-request-" + agent, "parent-message"]]);
    assert.equal(view.observedTotalTokens, 25);
    const checkpoint = await f.storage.readCheckpoint(source);
    await f.scan("child");
    assert.deepEqual(await f.storage.readSession(source), view);
    assert.deepEqual(await f.storage.readCheckpoint(source), checkpoint);
  }
  assert.deepEqual(await f.snapshot(), initial);
});

test("a verified final copy corrects the parent's provisional call at its original time and ID", async t => {
  const f = await ClaudeForkScanFixture.create("fork");
  t.after(() => f.close());
  await f.writeParent(100, { provisional: true });
  await f.scan("parent");
  const before = await f.storage.readSession(f.parent);
  assert(before);
  assert.equal(before.observedTotalTokens, 100);
  assert.equal(before.usage.length, 1);
  const [original] = before.usage;
  assert.equal(original.status, "provisional");
  const checkpoint = await f.storage.readCheckpoint(f.parent);

  await f.writeCopy(80);
  await f.appendOwn();
  await f.scan("child");
  const updated = await f.snapshot();
  assert.equal(updated.parent.observedTotalTokens, 80);
  assert.deepEqual(updated.parent.usage, [{
    ...original, revision: original.revision + 1, status: "final", inputTokens: 75, outputTokens: 5,
  }]);
  assert(updated.parentCheckpoint.version > checkpoint.version);
  assert.deepEqual(updated.parentCheckpoint.checkpoint, checkpoint.checkpoint);
  assert.equal(updated.child.observedTotalTokens, 25);
  assert.deepEqual(updated.child.usage.map(row => row.requestId), ["child-request-helper"]);
  assert.equal(updated.child.coverage, "reported");
  await f.scan("parent");
  await f.scan("child");
  assert.deepEqual(await f.snapshot(), updated);
});

test("a verified copy without a request ID leaves the child's separate request on the same message", async t => {
  const f = await ClaudeForkScanFixture.create("fork");
  t.after(() => f.close());
  await f.writeParent();
  await f.scan("parent");
  const before = await f.storage.readSession(f.parent);
  assert(before);
  await f.writeCopy(100, { omitRequest: true, provisional: true });
  await f.appendOwn(25, "parent-message");
  await f.scan("child");

  const result = await f.snapshot();
  assert.equal(result.child.observedTotalTokens, 25);
  assert.deepEqual(result.child.usage.map(row => [row.requestId, row.messageId]), [["child-request-helper", "parent-message"]]);
  assert.equal(result.child.coverage, "reported");
  assert.equal(result.parent.observedTotalTokens, 100);
  assert.deepEqual(result.parent.usage, before.usage);
  await f.scan("child");
  await f.scan("parent");
  assert.deepEqual(await f.snapshot(), result);
});
