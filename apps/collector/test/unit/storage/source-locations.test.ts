import assert from "node:assert/strict";
import { test } from "node:test";
import type { StreamKey } from "@tracerelic/collector/storage";
import { batch } from "../../fixtures/collector-storage-fixture.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";
import { inventoryLocation as location, inventoryScope as scope, inventorySource as source, measuredSource, presence } from "../../fixtures/source-inventory-fixture.ts";

test("Windows drive and UNC inventory is validated and scoped on any API host", async () => {
  const store = new InMemoryCollectorStorage();
  const root = String.raw`C:\Users\Desk\.claude`;
  const path = String.raw`projects\app\s.jsonl`;
  const projectDir = String.raw`C:\Users\Desk\.claude\projects\app`;
  const cwd = String.raw`\\files\share\WORK\repo`;
  const source = { harness: "claude", sessionId: "s", streamId: path, installationId: "desktop" } as const;
  const commit = (location: { root: string; path: string; projectDir?: string; cwd?: string }) =>
    store.commit(batch(0, 0, { source, sourceObservation: { location, observedEnd: 10 } }));
  for (const invalid of [String.raw`projects\..\elsewhere\s.jsonl`, String.raw`D:relative`, String.raw`D:\elsewhere`]) {
    assert.equal(await commit({ root, path: invalid, projectDir }), "invalid");
  }
  assert.equal(await commit({ root, path, projectDir, cwd }), "committed");
  const scope = { harness: "claude", installationId: "desktop", root } as const;
  for (const selected of [String.raw`\\FILES\SHARE\work`, "c:/users/desk/.CLAUDE/projects/app"]) {
    assert.equal((await store.listSources({ ...scope, projectPaths: [selected] })).length, 1);
  }
  for (const excluded of [String.raw`\\files\share\workshop`, String.raw`\\files\else\work`, "D:/users/desk", "/users/desk", "repo"]) {
    assert.deepEqual(await store.listSources({ ...scope, projectPaths: [excluded] }), []);
  }
  const older = { harness: "claude", sessionId: "old", streamId: root + "\\" + path } as const;
  assert.equal(await store.commit(batch(0, 0, { source: older })), "committed");
  assert.deepEqual((await store.listSources({ harness: "claude", root }))[0]?.location, { root, path, projectDir });
});

test("older anonymous scanner keys establish a root and older opaque or named keys first need a sighting", async () => {
  const store = new InMemoryCollectorStorage();
  const anonymous = { harness: "codex", sessionId: "old", streamId: JSON.stringify([location.root, location.path]) } as const;
  const claude = { harness: "claude", sessionId: "other", streamId: "/home/.claude/projects/work/s/subagents/agent-helper.jsonl" } as const;
  const keys: StreamKey[] = [anonymous, claude, source, { ...claude, sessionId: "opaque", streamId: "opaque" }];
  for (const key of keys) assert.equal(await store.commit(batch(0, 0, { source: key })), "committed");
  assert.deepEqual((await store.listSources({ ...scope, installationId: undefined })).map(item => item.source), [anonymous]);
  const scoped = { harness: "claude", root: "/home/.claude", projectPaths: ["/home/.claude/projects/work"] } as const;
  const [discovered] = await store.listSources(scoped);
  assert.deepEqual(discovered, {
    source: claude, location: { root: scoped.root, path: "projects/work/s/subagents/agent-helper.jsonl", projectDir: scoped.projectPaths[0] },
    version: 1, presence: "present", acceptedOffset: 10, observedEnd: 10,
  });
  assert.deepEqual(await store.listSources(scope), []);
  const update = { ...presence(1, "present", 10), expectedOffset: 10 };
  assert.equal(await store.recordPresence({ ...update, presence: "missing" }), "invalid");
  assert.equal(await store.recordPresence(update), "committed");
  assert.deepEqual((await store.listSources(scope)).map(item => item.source), [source]);
});

test("a source that already identifies its file cannot point discovery at an unrelated path", async () => {
  const store = new InMemoryCollectorStorage();
  const shifted = { ...location, path: "rollout-unrelated.jsonl" };
  const movedRoot = { ...location, root: "/new/home" };
  const first = measuredSource();
  assert.equal(await store.commit({ ...first, sourceObservation: { location: shifted, observedEnd: 420 } }), "invalid");
  assert.equal(await store.commit(first), "committed");
  for (const status of ["present", "missing"] as const) {
    assert.equal(await store.recordPresence({ ...presence(1, status), location: shifted }), "invalid");
  }
  assert.equal(await store.recordPresence({ ...presence(1, "present"), location: movedRoot }), "committed");
  assert.deepEqual(await store.listSources(scope), []);
  assert.deepEqual((await store.listSources({ ...scope, root: movedRoot.root }))[0].location, movedRoot);
  const anonymous = { harness: "codex", sessionId: "older", streamId: JSON.stringify([location.root, location.path]) } as const;
  assert.equal(await store.commit(batch(0, 0, { source: anonymous })), "committed");
  assert.equal(await store.recordPresence({ ...presence(1, "present", 10), source: anonymous, expectedOffset: 10, location: movedRoot }), "invalid");
});

test("Claude project selection follows the transcript's physical project", async () => {
  const store = new InMemoryCollectorStorage();
  const claude = { harness: "claude", sessionId: "s", streamId: "projects/a/s.jsonl", installationId: "desktop" } as const;
  const where = { root: "/home/claude", path: claude.streamId, projectDir: "/home/claude/projects/a" };
  for (const wrong of [{ ...where, projectDir: "/home/claude/projects/b" }, { ...where, path: "projects/b/s.jsonl" }]) {
    assert.equal(await store.commit(batch(0, 0, { source: claude, sourceObservation: { location: wrong, observedEnd: 10 } })), "invalid");
  }
  assert.equal(await store.commit(batch(0, 0, { source: claude, sourceObservation: { location: where, observedEnd: 10 } })), "committed");
});

test("a replaced generation without a working directory does not remain selected by the old directory", async () => {
  const store = new InMemoryCollectorStorage();
  const first = measuredSource();
  await store.commit(first);
  const observation = { location: { root: location.root, path: location.path }, observedEnd: 50 };
  const replacement = { offset: 50, parserState: "replacement", prefixDigest: "a".repeat(64) };
  const update = batch(1, 420, { source, resetFrom: first.checkpoint, checkpoint: replacement, sourceObservation: observation });
  assert.equal(await store.commit(update), "committed");
  assert.deepEqual(await store.listSources({ ...scope, projectPaths: ["/work"] }), []);
  assert.deepEqual((await store.listSources(scope))[0].location, observation.location);
});

test("an earlier Claude copy is selected by its own working directory or its current file's directory", async () => {
  const store = new InMemoryCollectorStorage();
  const claude = { harness: "claude", sessionId: "s", streamId: "projects/a/s.orphaned-2-id.jsonl", installationId: "desktop" } as const;
  const where = { root: "/home/claude", path: claude.streamId, projectDir: "/home/claude/projects/a",
    cwd: "/work/old/app", currentFileCwd: "/work/current/app" };
  assert.equal(await store.commit(batch(0, 0, { source: claude, sourceObservation: { location: where, observedEnd: 10 } })), "committed");
  for (const project of ["/work/old", "/work/current"]) {
    const [found] = await store.listSources({ ...scope, harness: "claude", root: where.root, projectPaths: [project] });
    assert.deepEqual(found?.location, where);
  }
  assert.deepEqual(await store.listSources({ ...scope, harness: "claude", root: where.root, projectPaths: ["/work/currently"] }), []);
});

test("inventory and missing reports expose only stream identity and location fields", async () => {
  const store = new InMemoryCollectorStorage();
  const extraSource = { ...source, unrelated: "private text" };
  const extraLocation = { ...location, labels: ["private path"] };
  assert.equal(await store.commit({ ...measuredSource(), source: extraSource, sourceObservation: { location: extraLocation, observedEnd: 420 } }), "committed");
  assert.equal(await store.recordPresence(presence(1, "missing")), "committed");
  const [known] = await store.listSources(scope);
  assert.deepEqual(known.source, source);
  assert.deepEqual(known.location, location);
  const first = await store.readSession(source);
  assert.deepEqual(first?.missingSources?.[0].source, source);
  first.missingSources[0].source.streamId = "edited";
  assert.deepEqual((await store.readSession(source))?.missingSources?.[0].source, source);
});

test("legacy source aliases require the two generations to use compatible ownership rules", async () => {
  for (const canonicalIsHistorical of [false, true]) {
    const store = new InMemoryCollectorStorage();
    const legacy = { ...source, streamId: JSON.stringify([location.root, location.path]) };
    const checkpoint = { offset: 10, parserState: "{}", prefixDigest: "a".repeat(64) };
    const first = batch(0, 0, { source: legacy, checkpoint, sourceObservation: { location, observedEnd: 10 } });
    assert.equal(await store.commit(first, undefined, true), "committed");
    assert.equal(await store.commit({ ...first, source, expectedVersion: 1 }, undefined, canonicalIsHistorical), "committed");
    assert.equal(await store.mergeSourceAlias(legacy, source.streamId, 2), canonicalIsHistorical);
  }
});
