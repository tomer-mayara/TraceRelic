import assert from "node:assert/strict";
import { test } from "node:test";
import type { PresenceWrite, SourceObservation, StreamKey } from "@tracerelic/collector/storage";
import { batch } from "../../fixtures/collector-storage-fixture.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";
import { inventoryLocation as location, inventoryScope as scope, inventorySource as source, measuredSource, presence } from "../../fixtures/source-inventory-fixture.ts";

for (const end of [420, 500]) {
  test(`reporting the acknowledged source missing once preserves its 70 tokens with complete end ${end}`, async () => {
    const store = new InMemoryCollectorStorage();
    const first = measuredSource(end);
    assert.equal(await store.commit(first), "committed");
    const [known] = await store.listSources(scope);
    assert.deepEqual(known, { source, location, version: 1, acceptedOffset: 420, observedEnd: end, presence: "present" });
    assert.equal((await store.readSession(source))?.coverage, "reported");
    assert.equal(await store.recordPresence(presence(1, "missing", end)), "committed");
    const view = await store.readSession(source);
    assert.deepEqual(view?.missingSources, [{ status: "missing", source, acceptedOffset: 420, observedEnd: end }]);
    assert.equal(view.coverage, end === 420 ? "reported" : "partial");
    assert.equal(view.observedTotalTokens, 70);
    assert.equal(await store.recordPresence(presence(1, "missing", end)), "conflict");
    assert.equal(await store.recordPresence(presence(2, "missing", end)), "committed");
    const loss = end > 420 ? { offset: end } : undefined;
    assert.deepEqual(await store.readCheckpoint(source), { version: 2, checkpoint: first.checkpoint, ...(loss && { observedThrough: loss }) });
    assert.deepEqual(await store.listSources(scope), [{ ...known, version: 2, presence: "missing", ...(loss && { unrecovered: loss }) }]);
    assert.deepEqual(await store.readSession(source), view);
    assert.equal(await store.recordPresence(presence(2, "present", end)), "committed");
    const returned = await store.readSession(source);
    assert.equal(returned?.missingSources, undefined);
    assert.equal(returned?.coverage, end === 420 ? "reported" : "partial");
    if (end > 420) {
      assert.equal(await store.commit(batch(3, 420, { source, checkpoint: { offset: end, parserState: "resumed" } })), "committed");
      assert.equal((await store.readSession(source))?.coverage, "partial", "a legacy byte count cannot prove the recovered suffix");
    }
  });
}

test("invokes the session version and source byte checks before publishing a presence change", async () => {
  const store = new InMemoryCollectorStorage();
  assert.equal(await store.recordPresence(presence(0, "missing")), "invalid");
  await store.commit(measuredSource());
  const other = { ...source, streamId: "rollout-another.jsonl" };
  assert.equal(await store.commit(batch(1, 0, { source: other })), "committed");
  assert.equal(await store.recordPresence(presence(1, "missing")), "conflict");
  assert.equal(await store.recordPresence({ ...presence(2, "missing"), expectedOffset: 419 }), "conflict");
  assert.equal((await store.readSession(source))?.missingSources, undefined);
  assert.equal(await store.recordPresence(presence(2, "missing")), "committed");
  assert.deepEqual(await store.readCheckpoint(other), { version: 3, checkpoint: { offset: 10, parserState: "{}" } });
});

test("matches each source by provider, configured root, installation and its own original selection fields", async () => {
  const store = new InMemoryCollectorStorage();
  const byProject = { root: "/home/claude", path: "projects/family/transcript.jsonl", projectDir: "/home/claude/projects/family", cwd: "/work/one/app" };
  const projectScope = { harness: "claude", installationId: "desktop", root: byProject.root } as const;
  const a: StreamKey = { harness: "claude", installationId: "desktop", sessionId: "one", streamId: byProject.path };
  const b: StreamKey = { ...a, sessionId: "two", streamId: "projects/unrelated/another.jsonl" };
  const other = { root: byProject.root, path: b.streamId, projectDir: "/home/claude/projects/unrelated", cwd: "/work/onesie" };
  for (const [key, where] of [[a, byProject], [b, other], [{ ...b, installationId: "laptop" }, other],
    [{ ...b, installationId: undefined }, other]] as const) {
    const { version } = await store.readCheckpoint(key);
    await store.commit(batch(version, 0, { source: key, sourceObservation: { location: where, observedEnd: 10 } }));
  }
  await store.commit(measuredSource());
  for (const filter of [{ projectPaths: ["/work/one"] }, { projectPaths: [byProject.projectDir] }, { sessionIds: ["one"] }]) {
    assert.deepEqual((await store.listSources({ ...projectScope, ...filter })).map(item => item.source), [a]);
  }
  const matches = await store.listSources({ ...projectScope, sessionIds: ["two"], projectPaths: ["/work/one"] });
  assert.deepEqual(matches.map(item => item.source), [a, b]);
  assert.deepEqual(await store.listSources({ ...projectScope, projectPaths: ["/home/claude/projects"] }), []);
  assert.deepEqual(await store.listSources({ ...projectScope, root: "/another/root" }), []);
  assert.deepEqual((await store.listSources({ ...projectScope, installationId: undefined })).map(item => item.source.streamId), [b.streamId]);
  matches[0].location.cwd = "/changed";
  matches[0].source.sessionId = "changed";
  assert.deepEqual((await store.listSources({ ...projectScope, sessionIds: ["one"] }))[0].location, byProject);
});

test("invalid observations and invalid presence writes leave the entire stored session intact", async () => {
  const store = new InMemoryCollectorStorage();
  const invalid = [
    { location, observedEnd: 419 }, { location, observedEnd: Infinity }, { location, observedEnd: 500.1 }, null,
    { location: { ...location, root: "relative" }, observedEnd: 500 }, { location: { ...location, path: "../other" }, observedEnd: 500 },
    { location: { ...location, cwd: "/root\0extra" }, observedEnd: 500 },
  ] as unknown as SourceObservation[];
  for (const sourceObservation of invalid) {
    assert.equal(await store.commit({ ...measuredSource(), sourceObservation }), "invalid");
  }
  assert.deepEqual(await store.listSources(scope), []);
  await store.commit(measuredSource());
  const view = await store.readSession(source);
  for (const obs of invalid.filter(Boolean)) {
    assert.equal(await store.recordPresence({ ...presence(1, "missing"), ...obs }), "invalid");
  }
  for (const bad of [{ presence: "absent" }, { expectedOffset: -1 }, { expectedVersion: 1.5 },
    { location: { ...location, root: "/another" } }]) {
    assert.equal(await store.recordPresence({ ...presence(1, "missing"), ...bad } as PresenceWrite), "invalid");
  }
  assert.deepEqual(await store.readSession(source), view);
  assert.equal((await store.readCheckpoint(source)).version, 1);
});

test("a rewrite at the lost end preserves the old generation's gap while a normal append can recover it", async () => {
  const store = new InMemoryCollectorStorage();
  const first = measuredSource(500);
  first.checkpoint.prefixDigest = "a".repeat(64);
  await store.commit(first);
  await store.recordPresence(presence(1, "missing", 500));
  const replacement = { offset: 500, parserState: "another generation", prefixDigest: "b".repeat(64) };
  assert.equal(await store.commit(batch(2, 420, { source, checkpoint: replacement, resetFrom: first.checkpoint })), "committed");
  const view = await store.readSession(source);
  assert.equal(view?.missingSources, undefined);
  assert.equal(view?.coverage, "partial");
  assert.equal(view?.observedTotalTokens, 70);
  assert.deepEqual(await store.listSources(scope), [{ source, location, version: 3, observedEnd: 500, acceptedOffset: 500, presence: "present", unrecovered: { offset: 500 } }]);
});

test("presence is isolated by source even when two installations share one measured session", async () => {
  const store = new InMemoryCollectorStorage();
  const other = { ...source, installationId: "laptop" };
  const first = measuredSource(500);
  await store.commit(first);
  await store.commit({ ...first, source: other, expectedVersion: 1 });
  const outcomes = await Promise.all([
    store.recordPresence(presence(2, "missing", 500)),
    store.recordPresence({ ...presence(2, "missing", 500), source: other }),
  ]);
  assert.deepEqual(outcomes, ["committed", "conflict"]);
  assert.equal(await store.recordPresence({ ...presence(3, "missing", 500), source: other }), "committed");
  const both = await store.readSession(source);
  assert.deepEqual(both?.missingSources?.map(report => report.source.installationId), ["desktop", "laptop"]);
  assert.equal(both.observedTotalTokens, 70);
  assert.equal(await store.commit(batch(4, 420, { source, checkpoint: { offset: 500, parserState: "complete" } })), "committed");
  const partial = await store.readSession(source);
  assert.deepEqual(partial?.missingSources?.map(report => report.source.installationId), ["laptop"]);
  assert.equal(partial.coverage, "partial");
  assert.equal(await store.commit(batch(5, 420, { source: other, checkpoint: { offset: 500, parserState: "complete" }, hasGap: true })), "committed");
  const restored = await store.readSession(source);
  assert.equal(restored?.missingSources, undefined);
  assert.equal(restored?.coverage, "partial");
  assert.equal(restored?.observedTotalTokens, 70);
});

test("a legacy replay checkpoint can establish complete bytes the earlier collector had yet to accept", async () => {
  const store = new InMemoryCollectorStorage();
  const first = measuredSource();
  await store.commit(first);
  const checkpoint = { offset: 420, parserState: "replaying", prefixDigest: "a".repeat(64),
    replayThrough: { offset: 500, prefixDigest: "b".repeat(64) } };
  assert.equal(await store.commit(batch(1, 420, { source, checkpoint, resetFrom: first.checkpoint })), "committed");
  assert.equal((await store.listSources(scope))[0].observedEnd, 500);
  assert.equal(await store.recordPresence(presence(2, "missing", 420)), "committed");
  assert.equal((await store.readSession(source))?.coverage, "partial");
});
