import assert from "node:assert/strict";
import { test } from "node:test";
import type { Batch, Message, StreamKey, Usage } from "../storage/collector-storage.js";
import { InMemoryCollectorStorage } from "./in-memory-collector-storage.js";

const source: StreamKey = { harness: "claude", sessionId: "chat-1", streamId: "main-v1" };
const planning: Message = {
  id: "m1", at: "2026-01-01T00:00:00Z", role: "user", text: "Plan the search feature",
};

function batch(expectedOffset: number, fields: Partial<Batch> = {}): Batch {
  return {
    source, expectedOffset, checkpoint: { offset: expectedOffset + 10, parserState: "{}" },
    messages: [], usage: [], ...fields,
  };
}

function request(fields: Partial<Usage> = {}): Usage {
  return {
    id: "req-1/msg-1", revision: 1, at: planning.at,
    inputTokens: 40, outputTokens: 2, ...fields,
  };
}

test("a planning chat preserves its message and has unknown usage", async () => {
  const store = new InMemoryCollectorStorage();
  const first = batch(0, { messages: [planning], metadata: { cwd: "/demo" } });
  assert.equal(await store.readSession(source), null);
  assert.equal(await store.readCheckpoint(source), null);

  assert.equal(await store.commit(first), "committed");
  assert.deepEqual(await store.readCheckpoint(source), first.checkpoint);
  assert.deepEqual(await store.readSession(source), {
    key: { harness: "claude", sessionId: "chat-1" }, metadata: { cwd: "/demo" },
    messages: [planning], usage: [], coverage: "unknown", observedTotalTokens: null,
  });
});

test("retrying after a lost acknowledgement returns the committed checkpoint", async () => {
  const store = new InMemoryCollectorStorage();
  const usage = request({ inputTokens: 120, outputTokens: 10, cacheReadTokens: 80, reasoningTokens: 5 });
  const first = batch(0, { usage: [usage] });
  assert.equal(await store.commit(first), "committed");
  assert.equal(await store.commit(first), "conflict");
  assert.deepEqual(await store.readCheckpoint(source), first.checkpoint);
  const session = await store.readSession(source);
  assert.deepEqual(session?.usage, [usage]);
  assert.equal(session?.observedTotalTokens, 130);
  assert.equal(session?.coverage, "reported");
});

test("a complete usage revision replaces a partial one and survives replay of the earlier version", async () => {
  const store = new InMemoryCollectorStorage();
  const partial = request({ cacheReadTokens: 10 });
  const complete = request({ revision: 2, outputTokens: 91 });
  await store.commit(batch(0, { messages: [planning], usage: [partial], metadata: { cwd: "/demo" } }));
  assert.equal(await store.commit(batch(10, { usage: [complete], metadata: { branch: "feature" } })), "committed");
  const distinct = request({ id: "req-2/msg-2", inputTokens: 3, outputTokens: 7 });
  assert.equal(await store.commit(batch(20, { usage: [partial, { ...complete }, distinct] })), "committed");
  const session = await store.readSession(source);
  assert.deepEqual(session?.usage, [complete, distinct]);
  assert.equal(session?.observedTotalTokens, 141);
  assert.deepEqual(session?.messages, [planning]);
  assert.deepEqual(session?.metadata, { cwd: "/demo", branch: "feature" });
});

test("invalid usage or an invalid cursor rejects every record in the batch", async () => {
  const store = new InMemoryCollectorStorage();
  const invalid: Partial<Usage>[] = [
    { cacheReadTokens: 41 }, { cacheReadTokens: 21, cacheWriteTokens: 20 },
    { reasoningTokens: 3 }, { cacheWriteTokens: -1 }, { reasoningTokens: 1.5 },
    { inputTokens: Number.NaN }, { outputTokens: Number.POSITIVE_INFINITY },
    { revision: 0 }, { revision: 1.5 }, { inputTokens: Number.MAX_SAFE_INTEGER + 1 },
    { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
  ];
  for (const fields of invalid) {
    const proposal = batch(0, { messages: [planning], usage: [request(fields)] });
    assert.equal(await store.commit(proposal), "invalid");
  }
  for (const offset of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await store.commit(batch(0, { checkpoint: { offset, parserState: "" } })), "invalid");
  }
  assert.equal(await store.commit(batch(-1)), "invalid");
  assert.equal(await store.readSession(source), null);
  assert.equal(await store.readCheckpoint(source), null);
});

test("conflicting records roll back new messages, metadata, usage and the checkpoint", async () => {
  const store = new InMemoryCollectorStorage();
  const first = batch(0, { messages: [planning], usage: [request()], metadata: { cwd: "/demo" } });
  await store.commit(first);
  const before = await store.readSession(source);
  const extra = { ...planning, id: "m2", text: "Follow up" };
  const changedMessage = batch(10, { messages: [extra, { ...planning, text: "Collision" }] });
  const changedUsage = batch(10, {
    messages: [extra], usage: [request({ id: "other" }), request({ outputTokens: 91 })],
    metadata: { branch: "discard" }, hasGap: true,
  });
  for (const proposal of [changedMessage, changedUsage]) {
    assert.equal(await store.commit(proposal), "invalid");
    assert.deepEqual(await store.readCheckpoint(source), first.checkpoint);
    assert.deepEqual(await store.readSession(source), before);
  }
  const identical = batch(10, { messages: [{ ...planning }], usage: [request()] });
  assert.equal(await store.commit(identical), "committed");
  assert.deepEqual(await store.readSession(source), before);
});

test("a measured zero differs from missing telemetry and a gap carries across subsequent batches", async () => {
  const store = new InMemoryCollectorStorage();
  const zero = request({ inputTokens: 0, outputTokens: 0 });
  await store.commit(batch(0, { hasGap: true }));
  const empty = await store.readSession(source);
  assert.equal(empty?.observedTotalTokens, null);
  assert.equal(empty?.coverage, "unknown");
  await store.commit(batch(10, { usage: [zero] }));
  const partial = await store.readSession(source);
  assert.equal(partial?.observedTotalTokens, 0);
  assert.equal(partial?.coverage, "partial");
  await store.commit(batch(20, { hasGap: false, usage: [request({ revision: 2 })] }));
  assert.equal((await store.readSession(source))?.coverage, "partial");

  const independent = new InMemoryCollectorStorage();
  await independent.commit(batch(0, { usage: [zero] }));
  assert.equal((await independent.readSession(source))?.coverage, "reported");
});

test("batches require nonempty identifiers and valid timestamped records", async () => {
  const store = new InMemoryCollectorStorage();
  const invalid: Partial<Batch>[] = [
    { source: { ...source, sessionId: "" } }, { source: { ...source, streamId: "" } },
    { metadata: { parentSessionId: "" } }, { messages: [{ ...planning, id: "" }] },
    { usage: [request({ id: "" })] }, { usage: [request({ at: "today" })] },
    { messages: [{ ...planning, at: "2025-02-29T00:00:00Z" }] },
    { messages: [{ ...planning, at: "2026-01-01T00:00:00" }] },
  ];
  for (const fields of invalid) assert.equal(await store.commit(batch(0, fields)), "invalid");
  assert.equal(await store.readSession(source), null);
  const valid = request({ at: "2024-02-29T01:00:00.123456+01:00" });
  assert.equal(await store.commit(batch(0, { usage: [valid] })), "committed");
});

test("competing writers can advance the same source offset only once", async () => {
  const store = new InMemoryCollectorStorage();
  const first = batch(0, { usage: [request()] });
  const rival = batch(0, { usage: [request({ id: "second-writer" })] });
  const results = await Promise.all([store.commit(first), store.commit(rival)]);
  assert.deepEqual(results.sort(), ["committed", "conflict"]);
  assert.equal((await store.readSession(source))?.usage.length, 1);
  assert.deepEqual(await store.readCheckpoint(source), first.checkpoint);
});

test("stream checkpoints, session observations and workspace state have independent scopes", async () => {
  const store = new InMemoryCollectorStorage();
  const joined = { ...source, streamId: "replayed-file-v2" };
  const other = { ...source, harness: "codex" } as const;
  await store.commit(batch(0, { usage: [request()] }));
  await store.commit(batch(0, { source: joined, usage: [request(), request({ id: "extra" })] }));
  await store.commit(batch(10, { source: joined }));
  await store.commit(batch(0, { source: other, usage: [request({ outputTokens: 12 })] }));

  assert.equal((await store.readSession(source))?.observedTotalTokens, 84);
  assert.equal((await store.readSession(other))?.observedTotalTokens, 52);
  assert.equal((await store.readCheckpoint(source))?.offset, 10);
  assert.equal((await store.readCheckpoint(joined))?.offset, 20);
  assert.equal(await new InMemoryCollectorStorage().readSession(source), null);
});

test("mutating batches and returned views does not mutate stored records or checkpoints", async () => {
  const store = new InMemoryCollectorStorage();
  const input = batch(0, { messages: [{ ...planning }], usage: [request()], metadata: { cwd: "/demo" } });
  await store.commit(input);
  const checkpoint = await store.readCheckpoint(source);
  const view = await store.readSession(source);
  assert.ok(checkpoint && view && input.metadata);
  input.checkpoint.offset = 180;
  input.messages[0].text = "mutated";
  input.usage[0].inputTokens = 100;
  input.metadata.cwd = "changed";
  checkpoint.parserState = "replaced";
  view.key.sessionId = "moved";
  view.messages.length = 0;
  view.usage.length = 0;
  assert.deepEqual(await store.readCheckpoint(source), { offset: 10, parserState: "{}" });
  const stored = await store.readSession(source);
  assert.deepEqual(stored?.messages, [planning]);
  assert.deepEqual(stored?.usage, [request()]);
  assert.equal(stored?.metadata.cwd, "/demo");
  assert.equal(stored?.key.sessionId, source.sessionId);
});

test("an aggregate that exceeds the safe integer range leaves the previous session intact", async () => {
  const store = new InMemoryCollectorStorage();
  const limit = request({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 });
  assert.equal(await store.commit(batch(0, { usage: [limit] })), "committed");
  assert.equal(await store.commit(batch(10, { usage: [request({ id: "overflow" })] })), "invalid");
  assert.deepEqual((await store.readSession(source))?.usage, [limit]);
  assert.equal((await store.readCheckpoint(source))?.offset, 10);
});

test("an absent optional property has the same meaning before and after wire serialization", async () => {
  const store = new InMemoryCollectorStorage();
  await store.commit(batch(0, { usage: [request()], metadata: { branch: "main" } }));
  const replay = batch(10, { usage: [request({ model: undefined })], metadata: { branch: undefined } });
  assert.equal(await store.commit(replay), "committed");
  const session = await store.readSession(source);
  assert.deepEqual(session?.usage, [request()]);
  assert.deepEqual(session?.metadata, { branch: "main" });
});
