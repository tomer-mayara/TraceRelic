import assert from "node:assert/strict";
import { test } from "node:test";
import { CollectorApiFixture } from "../fixtures/collector-api-fixture.ts";
import { batch, key, presence, scope, source, storedSource } from "../fixtures/collector-wire-payloads.ts";

test("two workspaces can store different chats under the same installation, session and stream IDs", async t => {
  const api = await CollectorApiFixture.open();
  t.after(() => api.close());
  const other = { ...batch, messages: [{ ...batch.messages[0], text: "A separate plan" }],
    usage: [{ ...batch.usage[0], inputTokens: 30 }], checkpoint: { ...batch.checkpoint, parserState: "other workspace" } };
  assert.deepEqual(await Promise.all([api.a.commit(batch), api.b.commit(other)]), ["committed", "committed"]);
  const [a, b] = await Promise.all([api.a.readSession(key), api.b.readSession(key)]);
  assert.deepEqual([a?.observedTotalTokens, b?.observedTotalTokens], [130, 40]);
  assert.deepEqual([a?.messages, b?.messages], [batch.messages, other.messages]);
  assert.deepEqual(await api.a.readCheckpoint(source), { version: 1, checkpoint: batch.checkpoint });
  assert.deepEqual(await api.b.readCheckpoint(source), { version: 1, checkpoint: other.checkpoint });
});

test("workspace selectors cannot redirect session, checkpoint, inventory, batch or presence operations", async t => {
  const api = await CollectorApiFixture.open();
  t.after(() => api.close());
  assert.equal(await api.a.commit(batch), "committed");
  const foreignWorkspace = { workspaceId: "workspace-a" };
  const foreignSource = { ...source, ...foreignWorkspace };
  const requests = [
    ["session", { ...key, ...foreignWorkspace }], ["checkpoint", foreignSource], ["sources", { ...scope, workspace: "workspace-a" }],
    ["batches", { ...batch, ...foreignWorkspace }], ["batches", { ...batch, source: foreignSource }],
    ["presence", { ...presence, ...foreignWorkspace }], ["presence", { ...presence, source: foreignSource }],
  ] as const;
  for (const [route, body] of requests) {
    const response = await api.b.post(route, body);
    assert.equal(response.status, 400, route);
    assert.deepEqual(await response.json(), { error: "bad-request" });
  }
  assert.deepEqual(await api.a.readCheckpoint(source), { version: 1, checkpoint: batch.checkpoint });
  assert.deepEqual(await api.a.listSources(scope), [storedSource]);
  assert.deepEqual(await api.b.readCheckpoint(source), { version: 0, checkpoint: null });
  assert.equal(await api.b.readSession(key), null);
  assert.deepEqual(await api.b.listSources(scope), []);
});

test("installations share a workspace session and keep separate checkpoints, inventories and presence", async t => {
  const api = await CollectorApiFixture.open();
  t.after(() => api.close());
  const desktopSource = { ...source, installationId: "desktop" };
  assert.equal(await api.a.commit({ ...batch, source: desktopSource }), "committed");
  assert.deepEqual(await api.laptop.readSession(key), await api.a.readSession(key));
  assert.deepEqual(await api.laptop.readCheckpoint(source), { version: 1, checkpoint: null });
  assert.deepEqual(await api.laptop.listSources(scope), []);
  const foreignRequests = [
    ["checkpoint", desktopSource], ["sources", { ...scope, installationId: "desktop" }],
    ["batches", { ...batch, source: desktopSource }], ["presence", { ...presence, source: desktopSource }],
  ] as const;
  for (const [route, body] of foreignRequests) {
    const response = await api.laptop.post(route, body);
    assert.equal(response.status, 400, route);
    assert.deepEqual(await response.json(), { error: "bad-request" });
  }
  const laptop = { ...batch, expectedVersion: 1, messages: [], usage: [],
    checkpoint: { ...batch.checkpoint, offset: 64 }, sourceObservation: { ...batch.sourceObservation, observedEnd: 64 } };
  assert.equal(await api.laptop.commit(laptop), "committed");
  assert.deepEqual(await api.laptop.readCheckpoint(source), { version: 2, checkpoint: laptop.checkpoint });
  assert.deepEqual(await api.a.readCheckpoint(desktopSource), { version: 2, checkpoint: batch.checkpoint });
  const missing = { ...presence, expectedVersion: 2, expectedOffset: 64, observedEnd: 64 };
  assert.equal(await api.laptop.recordPresence(missing), "committed");
  assert.equal(await api.laptop.recordPresence(missing), "conflict");
  assert.deepEqual(await api.laptop.listSources(scope), [{ ...storedSource, presence: "missing", version: 3,
    acceptedOffset: 64, observedEnd: 64, source: { ...source, installationId: "laptop" } }]);
  assert.deepEqual(await api.a.listSources(scope), [{ ...storedSource, version: 3 }]);
});
