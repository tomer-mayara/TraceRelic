import assert from "node:assert/strict";
import { test } from "node:test";
import { ScanActivity } from "#src/watch/scan-activity";
import { ScanPendingError } from "#src/scan/scan-pending";
import { batch, source } from "../../fixtures/collector-storage-fixture.ts";
import { PresenceConnection } from "../../fixtures/presence-connection.ts";
import { RejectingBatchStorage } from "../../fixtures/rejecting-batch-storage.ts";
import { inventoryScope } from "../../fixtures/source-inventory-fixture.ts";

test("a partial pass counts only newly accepted workspace sessions and distinguishes the two harnesses", async () => {
  const storage = new PresenceConnection();
  await storage.commit(batch(0, 0, { source: { ...source, sessionId: "existing" } }));
  const activity = new ScanActivity(storage, () => 0);
  activity.beginPass();
  await activity.readSession({ ...source, sessionId: "existing" });
  await activity.commit(batch(1, 10, { source: { ...source, sessionId: "existing" } }));
  await activity.commit(batch(0, 0));
  await activity.commit(batch(1, 0, { source: { ...source, streamId: "another-copy" } }));
  await activity.commit(batch(0, 0, { source: { ...source, harness: "codex" } }));
  assert.deepEqual(activity.finishPass({ status: "rejected" }), { status: "rejected", newSessions: 2, oldestPendingAgeMs: null });
  activity.beginPass();
  assert.equal(activity.finishPass({ status: "complete" }).newSessions, 0);
});

test("a rejected range keeps its original age across partial acceptance and work on another installation", async () => {
  let now = 10;
  let reject = true;
  const activity = new ScanActivity(new RejectingBatchStorage(() => reject), () => now);
  const attempted = batch(0, 0, { checkpoint: { offset: 20, parserState: "{}" } });
  activity.beginPass();
  assert.equal(await activity.commit(attempted), "invalid");
  assert.equal(activity.finishPass({ status: "rejected" }).oldestPendingAgeMs, 0);
  now = 42;
  activity.beginPass();
  assert.equal(await activity.commit(attempted), "invalid");
  reject = false;
  await activity.commit(batch(0, 0));
  await activity.commit(batch(1, 0, { source: { ...source, installationId: "other" } }));
  assert.equal(activity.finishPass({ status: "rejected" }).oldestPendingAgeMs, 32);
  now = 55;
  activity.beginPass();
  await activity.commit(batch(2, 10));
  assert.equal(activity.finishPass({ status: "complete" }).oldestPendingAgeMs, null);
});

test("a checkpoint read followed by a lost first write keeps the age until its durable checkpoint is verified", async () => {
  let now = 20;
  const storage = new PresenceConnection();
  const activity = new ScanActivity(storage, () => now);
  const pending = new ScanPendingError("storage-unavailable", source).pending;
  activity.beginPass();
  activity.pending(pending);
  assert.deepEqual(activity.finishPass({ status: "pending", retryAt: pending.retryAt }), {
    status: "pending", newSessions: 0, oldestPendingAgeMs: 0, retryAt: pending.retryAt,
  });
  now = 45;
  activity.beginPass();
  await activity.readCheckpoint(source);
  storage.loseFirstUpload = "reply";
  const first = batch(0, 0);
  await assert.rejects(activity.commit(first));
  activity.pending(new ScanPendingError("storage-unavailable", source, { startOffset: 0, endOffset: 10 }).pending);
  assert.equal(activity.finishPass({ status: "pending", retryAt: pending.retryAt }).oldestPendingAgeMs, 25);
  now = 70;
  activity.beginPass();
  storage.offline = false;
  const durable = await storage.readCheckpoint(source);
  await activity.verified(source, { ...durable, checkpoint: { ...first.checkpoint, parserState: "another state" } });
  assert.equal(activity.finishPass({ status: "pending", retryAt: pending.retryAt }).oldestPendingAgeMs, 50);
  await activity.readCheckpoint(source);
  assert.deepEqual(activity.finishPass({ status: "complete" }), { status: "complete", newSessions: 1, oldestPendingAgeMs: null });
  activity.beginPass();
  await activity.verified(source, durable);
  assert.equal(activity.finishPass({ status: "complete" }).newSessions, 0);
});

test("an unrelated session version and a different file prefix cannot acknowledge a lost first upload", async () => {
  let now = 0;
  const storage = new PresenceConnection();
  const activity = new ScanActivity(storage, () => now);
  const first = batch(0, 0, { checkpoint: { offset: 10, parserState: "first", prefixDigest: "captured" } });
  activity.beginPass();
  storage.loseFirstUpload = "request";
  await assert.rejects(activity.commit(first));
  const later = { version: 3, checkpoint: { offset: 30, parserState: "later", prefixDigest: "later-digest" } };
  now = 12;
  await activity.verified(source, { version: 3, checkpoint: null });
  await activity.verified(source, later, { prefixDigests: async () => [{ offset: 10, prefixDigest: "replaced" }] });
  assert.deepEqual(activity.finishPass({ status: "complete" }), { status: "complete", newSessions: 0, oldestPendingAgeMs: 12 });
  activity.beginPass();
  await activity.verified(source, later, { prefixDigests: async () => [{ offset: 10, prefixDigest: "captured" }] });
  assert.deepEqual(activity.finishPass({ status: "complete" }), { status: "complete", newSessions: 1, oldestPendingAgeMs: null });
});

test("only a successful query of the same inventory clears its pending age", async () => {
  let now = 7;
  const activity = new ScanActivity(new PresenceConnection(), () => now);
  const scope = { ...inventoryScope, sessionIds: ["one", "two"], projectPaths: ["/work"] };
  const pending = new ScanPendingError("storage-unavailable", scope).pending;
  activity.beginPass();
  activity.pending(pending);
  now = 18;
  await activity.listSources({ ...scope, sessionIds: ["one"] });
  await activity.listSources({ ...scope, installationId: "other" });
  assert.equal(activity.finishPass({ status: "pending", retryAt: pending.retryAt }).oldestPendingAgeMs, 11);
  activity.beginPass();
  await activity.listSources({ ...scope, sessionIds: ["two", "one"] });
  assert.equal(activity.finishPass({ status: "complete" }).oldestPendingAgeMs, null);
});

test("the age of a file changing before selection survives a successful inventory read", async () => {
  let now = 7;
  const activity = new ScanActivity(new PresenceConnection(), () => now);
  const pending = new ScanPendingError("source-changed", inventoryScope).pending;
  pending.sourceFile = "/history/sessions/rollout-moving.jsonl";
  const outcome = { status: "pending" as const, retryAt: pending.retryAt };
  activity.beginPass();
  activity.pending(pending);
  assert.equal(activity.finishPass(outcome).oldestPendingAgeMs, 0);
  now = 18;
  activity.beginPass();
  await activity.listSources(inventoryScope);
  activity.pending(pending);
  assert.equal(activity.finishPass(outcome).oldestPendingAgeMs, 11);
  activity.beginPass();
  await activity.listSources(inventoryScope);
  assert.equal(activity.finishPass({ status: "complete" }).oldestPendingAgeMs, null);
});

test("storage can accept all the bytes of a shorter repaired capture", async () => {
  const activity = new ScanActivity(new RejectingBatchStorage(batch => batch.checkpoint.offset === 23), () => 0);
  const sourceObservation = { location: { root: "/home", path: source.streamId }, observedEnd: 17 };
  assert.equal(await activity.commit(batch(0, 0, { checkpoint: { offset: 23, parserState: "{}" } })), "invalid");
  await activity.commit(batch(0, 0, { sourceObservation }));
  assert.equal(activity.finishPass({ status: "complete" }).oldestPendingAgeMs, 0);
  await activity.commit(batch(1, 10, { checkpoint: { offset: 17, parserState: "{}" }, sourceObservation }));
  assert.equal(activity.finishPass({ status: "complete" }).oldestPendingAgeMs, null);
});

test("a failed source-specific inventory reload does not leave an extra outstanding scope", async () => {
  const storage = new PresenceConnection();
  const activity = new ScanActivity(storage, () => 0);
  const narrow = { ...inventoryScope, sessionIds: [source.sessionId], projectPaths: [] };
  storage.offline = true;
  await assert.rejects(activity.listSources(narrow));
  activity.pending(new ScanPendingError("storage-unavailable", source).pending);
  activity.beginPass();
  storage.offline = false;
  await activity.readCheckpoint(source);
  await activity.listSources(inventoryScope);
  assert.equal(activity.finishPass({ status: "complete" }).oldestPendingAgeMs, null);
});

test("when the file disappears, its confirmed first checkpoint still counts after a lost reply", async () => {
  let now = 5;
  const storage = new PresenceConnection();
  const activity = new ScanActivity(storage, () => now);
  const scope = { harness: source.harness, root: "/home" };
  const first = batch(0, 0, { sourceObservation: { location: { root: scope.root, path: source.streamId }, observedEnd: 10 } });
  storage.loseFirstUpload = "reply";
  await assert.rejects(activity.commit(first));
  now = 25;
  activity.beginPass();
  storage.offline = false;
  await activity.listSources(scope);
  assert.deepEqual(activity.finishPass({ status: "complete" }), { status: "complete", newSessions: 1, oldestPendingAgeMs: null });
});

test("a checkpoint on another stream cannot make a dropped first request a new session", async () => {
  const storage = new PresenceConnection();
  const activity = new ScanActivity(storage, () => 0);
  const first = batch(0, 0);
  storage.loseFirstUpload = "request";
  await assert.rejects(activity.commit(first));
  await storage.commit(batch(0, 0, { source: { ...source, streamId: "competing-copy" } }));
  assert.deepEqual(await activity.readCheckpoint(source), { version: 1, checkpoint: null });
  await storage.commit({ ...first, expectedVersion: 1 });
  const accepted = await activity.readCheckpoint(source);
  await activity.verified(source, accepted);
  assert.deepEqual(activity.finishPass({ status: "complete" }), { status: "complete", newSessions: 0, oldestPendingAgeMs: null });
});
