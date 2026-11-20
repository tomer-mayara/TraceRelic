import assert from "node:assert/strict";
import { test } from "node:test";
import type { Batch, Usage } from "../../../src/storage/collector-storage.ts";
import { batch, planning, request, source } from "../../fixtures/collector-storage-fixture.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";

test("a planning chat preserves its message and has unknown usage", async () => {
  const store = new InMemoryCollectorStorage();
  const first = batch(0, 0, { messages: [planning], metadata: { cwd: "/demo" } });
  assert.deepEqual(await store.readCheckpoint(source), { version: 0, checkpoint: null });
  assert.equal(await store.readSession(source), null);

  assert.equal(await store.commit(first), "committed");
  assert.deepEqual(await store.readCheckpoint(source), { version: 1, checkpoint: first.checkpoint });
  assert.deepEqual(await store.readSession(source), {
    key: { harness: "claude", sessionId: "chat-1" }, metadata: { cwd: "/demo" },
    messages: [planning], usage: [], coverage: "unknown", observedTotalTokens: null,
  });
});

test("retrying after a lost acknowledgement returns the committed checkpoint", async () => {
  const store = new InMemoryCollectorStorage();
  const usage = request({ inputTokens: 120, outputTokens: 10, cacheReadTokens: 80, reasoningTokens: 5 });
  const first = batch(0, 0, { usage: [usage] });
  assert.equal(await store.commit(first), "committed");
  assert.equal(await store.commit(first), "conflict");
  assert.deepEqual(await store.readCheckpoint(source), { version: 1, checkpoint: first.checkpoint });
  const session = await store.readSession(source);
  assert.deepEqual(session?.usage, [usage]);
  assert.equal(session?.observedTotalTokens, 130);
  assert.equal(session?.coverage, "reported");
});

test("a complete usage revision replaces a partial one and survives replay of the earlier version", async () => {
  const store = new InMemoryCollectorStorage();
  const partial = request({ cacheReadTokens: 10 });
  const complete = request({ revision: 2, outputTokens: 91 });
  await store.commit(batch(0, 0, { messages: [planning], usage: [partial], metadata: { cwd: "/demo" } }));
  assert.equal(await store.commit(batch(1, 10, { usage: [complete], metadata: { branch: "feature" } })), "committed");
  const distinct = request({ id: "req-2/msg-2", inputTokens: 3, outputTokens: 7 });
  assert.equal(await store.commit(batch(2, 20, { usage: [partial, { ...complete }, distinct] })), "committed");
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
    const proposal = batch(0, 0, { messages: [planning], usage: [request(fields)] });
    assert.equal(await store.commit(proposal), "invalid");
  }
  for (const offset of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await store.commit(batch(0, 0, { checkpoint: { offset, parserState: "" } })), "invalid");
  }
  const missingState = { offset: 10 } as Batch["checkpoint"];
  assert.equal(await store.commit(batch(0, 0, { checkpoint: missingState })), "invalid");
  assert.equal(await store.commit(batch(0, -1)), "invalid");
  assert.equal(await store.readSession(source), null);
  assert.deepEqual(await store.readCheckpoint(source), { version: 0, checkpoint: null });
});

test("conflicting records roll back new messages, metadata, usage and the checkpoint", async () => {
  const store = new InMemoryCollectorStorage();
  const first = batch(0, 0, { messages: [planning], usage: [request()], metadata: { cwd: "/demo" } });
  await store.commit(first);
  const before = await store.readSession(source);
  const extra = { ...planning, id: "m2", text: "Follow up" };
  const changedMessage = batch(1, 10, { messages: [extra, { ...planning, text: "Collision" }] });
  const changedUsage = batch(1, 10, {
    messages: [extra], usage: [request({ id: "other" }), request({ outputTokens: 91 })],
    metadata: { branch: "discard" }, hasGap: true,
  });
  for (const proposal of [changedMessage, changedUsage]) {
    assert.equal(await store.commit(proposal), "invalid");
    assert.deepEqual(await store.readCheckpoint(source), { version: 1, checkpoint: first.checkpoint });
    assert.deepEqual(await store.readSession(source), before);
  }
  const identical = batch(1, 10, { messages: [{ ...planning }], usage: [request()] });
  assert.equal(await store.commit(identical), "committed");
  assert.deepEqual(await store.readSession(source), before);
});

test("a batch requires nonnegative safe integers for both expected values", async () => {
  const store = new InMemoryCollectorStorage();
  for (const field of ["expectedVersion", "expectedOffset"] as const) {
    for (const value of [undefined, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      const proposal = batch(0, 0, { [field]: value, messages: [planning] });
      assert.equal(await store.commit(proposal), "invalid", `${field} = ${value}`);
    }
  }
  assert.deepEqual(await store.readCheckpoint(source), { version: 0, checkpoint: null });
  assert.equal(await store.readSession(source), null);
});

test("a matching version requires the current offset and a strictly advancing checkpoint", async () => {
  const store = new InMemoryCollectorStorage();
  const first = batch(0, 0, { messages: [planning], metadata: { branch: "main" } });
  assert.equal(await store.commit(first), "committed");
  const view = await store.readSession(source);
  const change = { usage: [request()], metadata: { branch: "topic" }, hasGap: true };
  assert.equal(await store.commit(batch(1, 0, change)), "conflict");
  for (const offset of [9, 10]) {
    assert.equal(await store.commit(batch(1, 10, { ...change, checkpoint: { offset, parserState: "new" } })), "invalid");
  }
  assert.deepEqual(await store.readCheckpoint(source), { version: 1, checkpoint: first.checkpoint });
  assert.deepEqual(await store.readSession(source), view);
});

test("a measured zero differs from missing telemetry and a gap carries across subsequent batches", async () => {
  const store = new InMemoryCollectorStorage();
  const zero = request({ inputTokens: 0, outputTokens: 0 });
  await store.commit(batch(0, 0, { hasGap: true }));
  const empty = await store.readSession(source);
  assert.equal(empty?.observedTotalTokens, null);
  assert.equal(empty?.coverage, "unknown");
  await store.commit(batch(1, 10, { usage: [zero] }));
  const partial = await store.readSession(source);
  assert.equal(partial?.observedTotalTokens, 0);
  assert.equal(partial?.coverage, "partial");
  await store.commit(batch(2, 20, { hasGap: false, usage: [request({ revision: 2 })] }));
  assert.equal((await store.readSession(source))?.coverage, "partial");

  const independent = new InMemoryCollectorStorage();
  await independent.commit(batch(0, 0, { usage: [zero] }));
  assert.equal((await independent.readSession(source))?.coverage, "reported");
});

test("batches require nonempty identifiers and valid timestamped records", async () => {
  const store = new InMemoryCollectorStorage();
  const invalid: Partial<Batch>[] = [
    { source: { ...source, sessionId: "" } }, { source: { ...source, streamId: "" } },
    { source: { ...source, installationId: "" } },
    { metadata: { parentSessionId: "" } }, { messages: [{ ...planning, id: "" }] },
    { usage: [request({ id: "" })] }, { usage: [request({ at: "today" })] },
    { messages: [{ ...planning, at: "2025-02-29T00:00:00Z" }] },
    { messages: [{ ...planning, at: "2026-01-01T00:00:00" }] },
  ];
  for (const fields of invalid) assert.equal(await store.commit(batch(0, 0, fields)), "invalid");
  assert.equal(await store.readSession(source), null);
  const valid = request({ at: "2024-02-29T01:00:00.123456+01:00" });
  assert.equal(await store.commit(batch(0, 0, { usage: [valid] })), "committed");
});

test("competing writers can advance the same source offset only once", async () => {
  const store = new InMemoryCollectorStorage();
  const first = batch(0, 0, { usage: [request()] });
  const rival = batch(0, 0, { usage: [request({ id: "second-writer" })] });
  const results = await Promise.all([store.commit(first), store.commit(rival)]);
  assert.deepEqual(results.sort(), ["committed", "conflict"]);
  assert.equal((await store.readSession(source))?.usage.length, 1);
  assert.deepEqual(await store.readCheckpoint(source), { version: 1, checkpoint: first.checkpoint });
});

test("two writers on different sources must compare the same session version", async () => {
  const store = new InMemoryCollectorStorage();
  const other = { ...source, streamId: "second-log" };
  const first = batch(0, 0, { messages: [planning] });
  const second = batch(0, 0, { source: other, usage: [request()] });

  assert.deepEqual(await Promise.all([store.commit(first), store.commit(second)]), ["committed", "conflict"]);
  assert.deepEqual(await store.readCheckpoint(source), { version: 1, checkpoint: first.checkpoint });
  assert.deepEqual(await store.readCheckpoint(other), { version: 1, checkpoint: null });
  assert.deepEqual((await store.readSession(source))?.usage, []);

  assert.equal(await store.commit({ ...second, expectedVersion: 1 }), "committed");
  assert.deepEqual(await store.readCheckpoint(source), { version: 2, checkpoint: first.checkpoint });
  assert.deepEqual(await store.readCheckpoint(other), { version: 2, checkpoint: second.checkpoint });
  const view = await store.readSession(source);
  assert.deepEqual(view?.messages, [planning]);
  assert.deepEqual(view?.usage, [request()]);
});

test("stream checkpoints, session observations and workspace state have independent scopes", async () => {
  const store = new InMemoryCollectorStorage();
  const joined = { ...source, streamId: "replayed-file-v2" };
  const other = { ...source, harness: "codex" } as const;
  await store.commit(batch(0, 0, { usage: [request()] }));
  await store.commit(batch(1, 0, { source: joined, usage: [request(), request({ id: "extra" })] }));
  await store.commit(batch(2, 10, { source: joined }));
  await store.commit(batch(0, 0, { source: other, usage: [request({ outputTokens: 12 })] }));

  assert.equal((await store.readSession(source))?.observedTotalTokens, 84);
  assert.equal((await store.readSession(other))?.observedTotalTokens, 52);
  assert.equal((await store.readCheckpoint(source)).checkpoint?.offset, 10);
  assert.equal((await store.readCheckpoint(joined)).checkpoint?.offset, 20);
  assert.equal(await new InMemoryCollectorStorage().readSession(source), null);
});

test("installations sharing a session keep separate checkpoints and physical record order", async () => {
  const store = new InMemoryCollectorStorage();
  const laptop = { ...source, installationId: "laptop" };
  const desktop = { ...source, installationId: "desktop" };
  const firstMessage = { ...planning, sourceOrder: 5 };
  const laptopMessage = { ...planning, id: "m2", sourceOrder: 1 };
  const first = batch(0, 0, {
    messages: [firstMessage], metadata: { branch: "main" },
    branchObservation: { sourceOrder: 5, at: "2026-01-02T00:00:00Z" },
  });
  const second = batch(1, 0, {
    source: laptop, checkpoint: { offset: 25, parserState: "laptop" }, messages: [laptopMessage],
    metadata: { branch: "newer" }, branchObservation: { sourceOrder: 1, at: "2026-01-03T00:00:00Z" },
  });

  assert.equal(await store.commit(first), "committed");
  assert.deepEqual(await store.readCheckpoint(laptop), { version: 1, checkpoint: null });
  assert.equal(await store.commit(second), "committed");
  assert.deepEqual(await store.readCheckpoint(desktop), { version: 2, checkpoint: null });
  assert.deepEqual(await store.readCheckpoint(laptop), { version: 2, checkpoint: second.checkpoint });
  assert.deepEqual(await store.readCheckpoint({ ...source, installationId: undefined }), {
    version: 2, checkpoint: first.checkpoint,
  });
  const view = await store.readSession(source);
  assert.deepEqual(view?.messages, [firstMessage, laptopMessage]);
  assert.deepEqual(view?.metadata, { branch: "newer" });
});

test("mutating batches and returned views does not mutate stored records or checkpoints", async () => {
  const store = new InMemoryCollectorStorage();
  const input = batch(0, 0, { messages: [{ ...planning }], usage: [request()], metadata: { cwd: "/demo" } });
  await store.commit(input);
  const snapshot = await store.readCheckpoint(source);
  const view = await store.readSession(source);
  assert.ok(snapshot.checkpoint && view && input.metadata);
  input.checkpoint.offset = 180;
  input.messages[0].text = "mutated";
  input.usage[0].inputTokens = 100;
  input.metadata.cwd = "changed";
  snapshot.version = 99;
  snapshot.checkpoint.parserState = "replaced";
  view.key.sessionId = "moved";
  view.messages.length = 0;
  view.usage.length = 0;
  assert.deepEqual(await store.readCheckpoint(source), { version: 1, checkpoint: { offset: 10, parserState: "{}" } });
  const stored = await store.readSession(source);
  assert.deepEqual(stored?.messages, [planning]);
  assert.deepEqual(stored?.usage, [request()]);
  assert.equal(stored?.metadata.cwd, "/demo");
  assert.equal(stored?.key.sessionId, source.sessionId);
});

test("an aggregate that exceeds the safe integer range leaves the previous session intact", async () => {
  const store = new InMemoryCollectorStorage();
  const limit = request({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 });
  assert.equal(await store.commit(batch(0, 0, { usage: [limit] })), "committed");
  assert.equal(await store.commit(batch(1, 10, { usage: [request({ id: "overflow" })] })), "invalid");
  assert.deepEqual((await store.readSession(source))?.usage, [limit]);
  assert.equal((await store.readCheckpoint(source)).checkpoint?.offset, 10);
});

test("an absent optional property has the same meaning before and after wire serialization", async () => {
  const store = new InMemoryCollectorStorage();
  await store.commit(batch(0, 0, { usage: [request()], metadata: { branch: "main" } }));
  const replay = batch(1, 10, { usage: [request({ model: undefined })], metadata: { branch: undefined } });
  assert.equal(await store.commit(replay), "committed");
  const session = await store.readSession(source);
  assert.deepEqual(session?.usage, [request()]);
  assert.deepEqual(session?.metadata, { branch: "main" });
});

test("a replay can identify a legacy message and preserves its first verified position", async () => {
  const store = new InMemoryCollectorStorage();
  const identified = {
    ...planning, sourceOrder: 7, blockIndex: 1, turnId: "turn-1", context: { cwd: "/demo" },
  };
  const copy = { ...source, streamId: "archived-copy" };
  assert.equal(await store.commit(batch(0, 0, { messages: [planning] })), "committed");
  assert.equal(await store.commit(batch(1, 10, { messages: [identified] })), "committed");
  assert.equal(await store.commit(batch(2, 0, {
    source: copy, messages: [{
      ...planning, sourceOrder: 2, blockIndex: 0, requestId: "request-1", context: { branch: "topic" },
    }],
  })), "committed");
  assert.equal(await store.commit(batch(3, 20, { messages: [planning] })), "committed");
  const view = await store.readSession(source);
  assert.deepEqual(view?.messages, [{
    ...identified, requestId: "request-1", context: { cwd: "/demo", branch: "topic" },
  }]);
  assert.equal(view?.coverage, "unknown");
  assert.equal(view?.observedTotalTokens, null);
});

test("blocks within one stream use their record and block positions even when they arrive out of order", async () => {
  const store = new InMemoryCollectorStorage();
  const first = { ...planning, sourceOrder: 1, blockIndex: 0 };
  const second = { ...planning, id: "block-2", sourceOrder: 1, blockIndex: 2 };
  const later = { ...planning, id: "later", sourceOrder: 3 };
  const other = { ...source, streamId: "other-log" };
  const independent = { ...planning, id: "other", sourceOrder: 1 };
  await store.commit(batch(0, 0, { messages: [later] }));
  await store.commit(batch(1, 0, { source: other, messages: [independent] }));
  await store.commit(batch(2, 10, { messages: [second, first] }));
  const view = await store.readSession(source);
  assert.deepEqual(view?.messages.filter(message => message.id !== independent.id), [first, second, later]);
  assert.equal(view?.messages.filter(message => message.id === independent.id).length, 1);
});

test("the latest branch follows recorded order within a stream and recorded time between streams", async () => {
  const store = new InMemoryCollectorStorage();
  const other = { ...source, streamId: "other-log" };
  const instant = "2026-02-01T10:00:00.000002Z";
  const tied = "2026-02-01T12:00:00.000002+02:00";
  const branch = async (offset: number, stream: typeof source, name: string, at: string, sourceOrder: number) => {
    const { version } = await store.readCheckpoint(stream);
    assert.equal(await store.commit(batch(version, offset, {
      source: stream, metadata: { branch: name }, branchObservation: { at, sourceOrder },
    })), "committed");
    return (await store.readSession(source))?.metadata.branch;
  };

  assert.equal(await branch(0, source, "main", instant, 7), "main");
  assert.equal(await branch(10, source, "later-line", "2026-02-01T09:00:00Z", 9), "later-line");
  assert.equal(await branch(20, source, "replayed", instant, 7), "later-line");
  assert.equal(await branch(0, other, "later-instant", instant, 1), "later-instant");
  assert.equal(await branch(30, source, "tied", tied, 12), "later-instant");
  assert.equal(await branch(40, source, "newest", "2026-02-01T10:00:00.000003Z", 13), "newest");
  assert.equal(await branch(10, other, "replay-at-same-position", "2026-03-01T00:00:00Z", 1), "newest");
  assert.equal(await store.commit(batch(7, 50, { metadata: { branch: "unpositioned", cwd: "/demo" } })), "committed");
  assert.deepEqual((await store.readSession(source))?.metadata, { cwd: "/demo", branch: "newest" });
});

test("an undated branch advances in its own stream and has no recorded order against another stream", async () => {
  const store = new InMemoryCollectorStorage();
  const other = { ...source, streamId: "other-log" };
  const dated = { sourceOrder: 3, at: planning.at };
  const changes = [
    { stream: source, offset: 0, observation: dated, branch: "main", expected: "main" },
    { stream: source, offset: 10, observation: { sourceOrder: 4 }, branch: "topic", expected: "topic" },
    { stream: source, offset: 20, observation: dated, branch: "main", expected: "topic" },
    { stream: other, offset: 0, observation: dated, branch: "independent", expected: "topic" },
    { stream: source, offset: 30, observation: { sourceOrder: 5, at: planning.at }, branch: "dated", expected: "dated" },
    { stream: other, offset: 10, observation: { sourceOrder: 6 }, branch: "undated-copy", expected: "dated" },
  ];
  for (const { stream, offset, observation, branch, expected } of changes) {
    const { version } = await store.readCheckpoint(stream);
    assert.equal(await store.commit(batch(version, offset, {
      source: stream, metadata: { branch }, branchObservation: observation,
    })), "committed", branch);
    assert.equal((await store.readSession(source))?.metadata.branch, expected);
  }
});

test("invalid message evidence or a branch observation rejects the batch and its checkpoint", async () => {
  const store = new InMemoryCollectorStorage();
  const branchObservation = { at: planning.at, sourceOrder: 1 };
  const invalid: Partial<Batch>[] = [
    ...[0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(sourceOrder => ({ messages: [{ ...planning, sourceOrder }] })),
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(blockIndex => ({ messages: [{ ...planning, blockIndex }] })),
    { messages: [{ ...planning, turnId: "" }] }, { messages: [{ ...planning, requestId: "" }] },
    { messages: [{ ...planning, context: { parentSessionId: "" } }] },
    { messages: [{ ...planning, context: { cwd: 9 as unknown as string } }] },
    { branchObservation }, { metadata: { branch: "" }, branchObservation },
    { metadata: { branch: "topic" }, branchObservation: { ...branchObservation, at: "yesterday" } },
    ...[0, 1.5, Number.MAX_SAFE_INTEGER + 1].map(sourceOrder => ({
      metadata: { branch: "topic" }, branchObservation: { ...branchObservation, sourceOrder },
    })),
  ];
  for (const fields of invalid) {
    assert.equal(await store.commit(batch(0, 0, { usage: [request()], ...fields })), "invalid", JSON.stringify(fields));
  }
  assert.equal(await store.readSession(source), null);
  assert.deepEqual(await store.readCheckpoint(source), { version: 0, checkpoint: null });
});

test("a replay with contradictory recorded evidence leaves the original message and checkpoint intact", async () => {
  const store = new InMemoryCollectorStorage();
  const original = {
    ...planning, sourceOrder: 4, turnId: "turn-1", requestId: "request-1", context: { repository: "trace" },
  };
  const first = batch(0, 0, { messages: [original] });
  assert.equal(await store.commit(first), "committed");
  for (const fields of [
    { role: "assistant" as const }, { text: "changed" }, { at: "2026-03-01T00:00:00Z" },
    { turnId: "turn-2" }, { requestId: "request-2" }, { context: { repository: "another" } },
  ]) {
    assert.equal(await store.commit(batch(1, 10, {
      messages: [{ ...original, ...fields }], metadata: { branch: "rejected" },
    })), "invalid");
    assert.deepEqual(await store.readCheckpoint(source), { version: 1, checkpoint: first.checkpoint });
    assert.deepEqual((await store.readSession(source))?.messages, [original]);
    assert.deepEqual((await store.readSession(source))?.metadata, {});
  }
});
