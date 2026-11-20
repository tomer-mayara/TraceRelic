import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexForkScanFixture } from "../../fixtures/codex-fork-scan-fixture.ts";

for (const unavailable of ["missing", "unselected"] as const) {
  test(`a previously ${unavailable} parent resolves an unchanged child transcript`, async t => {
    const f = await CodexForkScanFixture.create();
    t.after(() => f.close());
    const ranges = await f.writeChild(200, 225);
    if (unavailable === "unselected") await f.writeParent(200, 260);

    const initial = await f.scan(...(unavailable === "unselected" ? ["child"] : []));
    assert.equal(initial.length, 1);
    const [child] = initial;
    assert.equal(child.observedTotalTokens, 5, "only the request in the child's own turn has a known owner");
    assert.equal(child.coverage, "partial");
    assert.equal(child.metadata.parentSessionId, "parent");
    assert.deepEqual(child.messages.map(row => row.text), ["Inherited plan", "Child plan"]);
    assert.deepEqual(child.usage.map(row => row.requestId), ["child-request"]);
    assert.deepEqual(child.usageDiagnostics?.filter(row => row.code === "unresolved-codex-fork"), [{
      code: "unresolved-codex-fork", sourceOrder: ranges.firstUncertain.lineNumber, byteRange: ranges.byteRange,
      installationId: f.child.installationId, streamId: f.child.streamId,
    }]);
    const before = await f.checkpoints();
    assert.deepEqual(before.parent, { version: 0, checkpoint: null });
    assert.partialDeepStrictEqual(before.child.checkpoint, {
      codexFork: { parentSessionId: "parent", firstUncertain: ranges.firstUncertain },
    });
    assert.deepEqual(await f.scan("child"), initial);
    assert.deepEqual(await f.checkpoints(), before);

    if (unavailable === "missing") await f.writeParent(200, 260);
    const repaired = await f.scan();
    const resolved = repaired.find(view => view.key.sessionId === "child");
    assert(resolved);
    assert.equal(repaired.find(view => view.key.sessionId === "parent")?.observedTotalTokens, 260);
    assert.equal(resolved.observedTotalTokens, 25);
    assert.deepEqual(resolved.messages, child.messages);
    assert.deepEqual(resolved.usage.filter(row => row.requestId === "child-request"), child.usage);
    const after = await f.checkpoints();
    assert.equal(after.child.checkpoint?.offset, before.child.checkpoint?.offset);
    assert.equal(after.child.checkpoint?.prefixDigest, before.child.checkpoint?.prefixDigest);
    assert(after.child.version > before.child.version);
    assert.partialDeepStrictEqual(after.child.checkpoint, {
      codexFork: { parentSessionId: "parent", inheritedThrough: ranges.inheritedThrough, baseline: ranges.baseline },
    });
    assert.deepEqual(await f.scan("child"), [resolved]);
    assert.deepEqual(await f.checkpoints(), after);

    await f.appendTotal(f.parent, 300);
    const advanced = await f.scan();
    assert.equal(advanced.find(view => view.key.sessionId === "parent")?.observedTotalTokens, 300);
    assert.deepEqual(advanced.find(view => view.key.sessionId === "child"), resolved);
    assert.deepEqual((await f.checkpoints()).child, after.child);
  });
}

test("a verified first child call starts a fresh counter after the archived child copies its parent", async t => {
  const f = await CodexForkScanFixture.create("child");
  t.after(() => f.close());
  await f.writeParent(200, 260);
  await f.writeChild(200, 25, true);
  assert.deepEqual((await f.discover()).map(source => source.sessionId), ["parent", "child"]);
  const views = await f.scan();
  const child = views.find(view => view.key.sessionId === "child");
  assert(child);
  assert.equal(views.find(view => view.key.sessionId === "parent")?.observedTotalTokens, 260);
  assert.equal(child.observedTotalTokens, 25);
  assert.equal(child.coverage, "reported");
  assert.deepEqual(child.usage.map(({ requestId, inputTokens, outputTokens }) => [requestId, inputTokens, outputTokens]),
    [["child-request", 20, 5]]);
  const before = await f.checkpoints();
  assert.deepEqual(await f.scan(), views);
  assert.deepEqual(await f.checkpoints(), before);
});

test("a lower anonymous child total retains only the independently recorded call", async t => {
  const f = await CodexForkScanFixture.create();
  t.after(() => f.close());
  await f.writeParent(200, 260);
  await f.writeChild(200, 25);
  const child = (await f.scan()).find(view => view.key.sessionId === "child");
  assert(child);
  assert.equal(child.coverage, "partial");
  assert.equal(child.observedTotalTokens, 5);
  assert.deepEqual(child.usage.map(row => row.requestId), ["child-request"]);
});

test("a child confirms its first cumulative counter by repeating its first native call", async t => {
  const f = await CodexForkScanFixture.create();
  t.after(() => f.close());
  await f.writeParent(200, 260);
  await f.writeChildWithFreshCall(5, 25);
  const views = await f.scan();
  const child = views.find(view => view.key.sessionId === "child");
  assert.equal(child?.observedTotalTokens, 25);
  assert.equal(child.coverage, "reported");
  assert.deepEqual(child.usage.filter(row => row.kind === "call").map(row => row.requestId), ["child-request"]);
  assert.deepEqual(await f.scan(), views);
});

test("a scan corrects inherited usage already accepted by a version 2 writer", async t => {
  const f = await CodexForkScanFixture.create();
  t.after(() => f.close());
  await f.writeChild(200, 225);
  await f.importLegacyChild();
  const old = await f.storage.readSession(f.child);
  assert.equal(old?.observedTotalTokens, 145);
  const before = await f.storage.readCheckpoint(f.child);
  assert(before.checkpoint);
  await f.writeParent(200, 260);

  const views = await f.scan();
  const child = views.find(view => view.key.sessionId === "child");
  assert.equal(child?.observedTotalTokens, 25);
  assert.equal(child.metadata.parentSessionId, "parent");
  assert.deepEqual(child.messages, old.messages);
  assert.deepEqual(child.usage.filter(row => row.kind === "call").map(row => row.requestId), ["child-request"]);
  const parent = views.find(view => view.key.sessionId === "parent");
  assert.equal(parent?.observedTotalTokens, 260);
  assert.equal(parent.usage.filter(row => row.requestId === "parent-request").length, 1);
  const after = await f.storage.readCheckpoint(f.child);
  assert(after.version > before.version);
  assert.equal(after.checkpoint?.offset, before.checkpoint.offset);
  assert.equal(after.checkpoint?.prefixDigest, before.checkpoint.prefixDigest);
  assert.deepEqual(await f.scan(), views);
  assert.deepEqual(await f.storage.readCheckpoint(f.child), after);
});

test("a child-only append uses a fork boundary verified by a previous scan", async t => {
  const f = await CodexForkScanFixture.create();
  t.after(() => f.close());
  await f.writeParent(200, 260);
  await f.writeChild(200, 225);
  const initial = (await f.scan()).find(view => view.key.sessionId === "child");
  assert.equal(initial?.observedTotalTokens, 25);
  const before = await f.checkpoints();
  await f.appendTotal(f.child, 255);
  const [child] = await f.scan("child");
  assert.equal(child.observedTotalTokens, 55);
  assert.equal(child.coverage, "reported");
  assert.deepEqual(child.messages, initial.messages);
  const after = await f.checkpoints();
  assert.deepEqual(after.parent, before.parent);
  assert.deepEqual(after.child.checkpoint?.codexFork, before.child.checkpoint?.codexFork);
  assert.deepEqual(await f.scan("child"), [child]);
  assert.deepEqual(await f.checkpoints(), after);
});

test("a selected parent whose call identity changed withdraws disputed usage from the unchanged child", async t => {
  const f = await CodexForkScanFixture.create();
  t.after(() => f.close());
  await f.writeParent(200, 260);
  const { firstUncertain } = await f.writeChild(200, 225);
  const verified = (await f.scan()).find(view => view.key.sessionId === "child");
  assert.equal(verified?.observedTotalTokens, 25);
  const before = (await f.checkpoints()).child;

  await f.writeParent(200, 260, "different-request");
  const disputed = (await f.scan()).find(view => view.key.sessionId === "child");
  assert.equal(disputed?.observedTotalTokens, 5);
  assert.equal(disputed.coverage, "partial");
  assert.deepEqual(disputed.messages, verified.messages);
  assert.deepEqual(disputed.usage.map(row => row.requestId), ["child-request"]);
  const after = (await f.checkpoints()).child;
  assert(after.version > before.version);
  assert.equal(after.checkpoint?.offset, before.checkpoint?.offset);
  assert.deepEqual(after.checkpoint?.codexFork, { parentSessionId: "parent", firstUncertain });
  assert.deepEqual((await f.scan()).find(view => view.key.sessionId === "child"), disputed);
  assert.deepEqual((await f.checkpoints()).child, after);
});
