import assert from "node:assert/strict";
import { test } from "node:test";
import type { Checkpoint } from "../../../src/storage/collector-storage.ts";
import { batch, claudeParserState, codexSource, planning, request, source } from "../../fixtures/collector-storage-fixture.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";

test("a version-checked reset can replace the saved byte and retain accepted records", async () => {
  const saved = { offset: 10, parserState: "first", prefixDigest: "a".repeat(64) };
  const emptyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  for (const offset of [0, 8, 10, 12]) {
    const store = new InMemoryCollectorStorage();
    const first = request();
    const second = request({ id: "new" });
    assert.equal(await store.commit(batch(0, 0, { checkpoint: saved, messages: [planning], usage: [first] })), "committed");
    const checkpoint = { offset, parserState: "replacement", prefixDigest: offset === 0 ? emptyDigest : "b".repeat(64) };
    const usage = offset === 0 ? [] : [first, second];
    assert.equal(await store.commit(batch(1, 10, { checkpoint, resetFrom: saved, usage })), "committed");
    assert.equal(await store.commit(batch(1, 10, {
      checkpoint: { ...saved, offset: 20 }, usage: [request({ id: "stale" })],
    })), "conflict");
    assert.deepEqual(await store.readCheckpoint(source), { version: 2, checkpoint });
    const view = await store.readSession(source);
    assert.deepEqual(view?.messages, [planning]);
    assert.deepEqual(view?.usage, offset === 0 ? [first] : [first, second]);
  }
});

test("a reset requires an exact checkpoint and rolls back all changes on a conflict or invalid batch", async () => {
  const store = new InMemoryCollectorStorage();
  const saved = { offset: 10, parserState: "saved", prefixDigest: "a".repeat(64) };
  const checkpoint = { offset: 12, parserState: "replacement", prefixDigest: "b".repeat(64) };
  assert.equal(await store.commit(batch(0, 0, { checkpoint, resetFrom: saved })), "invalid");
  assert.equal(await store.commit(batch(0, 0, { checkpoint: saved, messages: [planning] })), "committed");
  const before = await store.readSession(source);
  const replacement = batch(1, 10, { checkpoint, resetFrom: saved, usage: [request()], hasGap: true });
  for (const resetFrom of [
    { ...saved, offset: 9 }, { ...saved, parserState: "older" }, { ...saved, prefixDigest: "c".repeat(64) },
    { ...saved, receipt: "unrecognized generation" },
    { offset: 10, parserState: saved.parserState },
  ]) {
    assert.equal(await store.commit({ ...replacement, resetFrom }), "conflict");
  }
  for (const fields of [
    { upgradeFromParserState: saved.parserState },
    { resetFrom: { ...saved, prefixDigest: "broken" } },
    { checkpoint: { ...checkpoint, offset: 0 } },
    { checkpoint: { offset: 12, parserState: "no digest" } },
    { messages: [{ ...planning, text: "Different content" }] },
  ]) {
    assert.equal(await store.commit({ ...replacement, ...fields }), "invalid");
  }
  assert.deepEqual(await store.readCheckpoint(source), { version: 1, checkpoint: saved });
  assert.deepEqual(await store.readSession(source), before);
});

test("a checkpoint can acquire a digest on reset and subsequent writes must preserve its evidence", async () => {
  const store = new InMemoryCollectorStorage();
  const saved = { offset: 10, parserState: "{}" };
  for (const prefixDigest of ["truncated", "a".repeat(65), "A".repeat(64), null]) {
    const malformed = { ...saved, prefixDigest } as Checkpoint;
    assert.equal(await store.commit(batch(0, 0, { checkpoint: malformed })), "invalid");
  }
  assert.equal(await store.commit(batch(0, 0, { checkpoint: saved })), "committed");
  const checkpoint = { ...saved, prefixDigest: "a".repeat(64) };
  assert.equal(await store.commit(batch(1, 10, { resetFrom: saved, checkpoint })), "committed");
  assert.equal(await store.commit(batch(2, 10)), "invalid");
  const upgraded = { ...checkpoint, parserState: claudeParserState(2) };
  assert.equal(await store.commit(batch(2, 10, {
    upgradeFromParserState: saved.parserState, checkpoint: { ...upgraded, prefixDigest: "b".repeat(64) },
  })), "invalid");
  assert.equal(await store.commit(batch(2, 10, { upgradeFromParserState: saved.parserState, checkpoint: upgraded })), "committed");
  assert.deepEqual(await store.readCheckpoint(source), { version: 3, checkpoint: upgraded });
});

test("either provider can identify ambiguous replay rows by source and physical line", async () => {
  const diagnostic = { code: "ambiguous-transcript-replay", sourceOrder: 3 } as const;
  for (const stream of [source, codexSource]) {
    const store = new InMemoryCollectorStorage();
    assert.equal(await store.commit(batch(0, 0, {
      source: stream, usage: [request()], usageDiagnostics: [diagnostic, diagnostic], hasGap: true,
    })), "committed");
    const view = await store.readSession(stream);
    assert.deepEqual(view?.usageDiagnostics, [{ ...diagnostic, streamId: stream.streamId }]);
    assert.equal(view.coverage, "partial");
  }
});

test("historical repair matches the accepted lines, replay reservations and previous checkpoint before it changes a generation", async () => {
  const store = new InMemoryCollectorStorage();
  const bounds = { ["d".repeat(64)]: { accepted: 2, replayed: 0 } };
  const state = { version: 3, lineNumber: 2, decoder: { occurrences: {} }, replayOccurrences: bounds };
  const old = { offset: 20, prefixDigest: "a".repeat(64), parserState: JSON.stringify(state) };
  assert.equal(await store.commit(batch(0, 0, { checkpoint: old, messages: [planning] })), "committed");
  const checkpoint = { ...old, evidenceVersion: 1 as const, claudeCallOrigins: true as const };
  const repair = batch(1, 20, { repairEvidenceFrom: old, checkpoint });
  for (const parserState of ["{}", JSON.stringify({ ...state, lineNumber: 1 }), JSON.stringify({ ...state, replayOccurrences: {} })]) {
    assert.equal(await store.commit({ ...repair, checkpoint: { ...checkpoint, parserState } }), "invalid");
    assert.deepEqual((await store.readSession(source))?.messages, [planning]);
  }
  assert.equal(await store.commit({ ...repair, repairEvidenceFrom: { ...old, prefixDigest: "b".repeat(64) } }), "conflict");
  assert.equal(await store.commit(repair), "committed");
  assert.deepEqual((await store.readSession(source))?.messages, []);
});

test("a partial replay pins its inspected bytes through subsequent checkpoints", async () => {
  const store = new InMemoryCollectorStorage();
  const saved = { offset: 30, parserState: "first", prefixDigest: "a".repeat(64) };
  const replayThrough = { offset: 40, prefixDigest: "b".repeat(64) };
  const partial = { offset: 10, parserState: "{}", prefixDigest: "c".repeat(64), replayThrough };
  const write = (version: number, offset: number, checkpoint: Checkpoint) => batch(version, offset, { checkpoint });
  assert.equal(await store.commit(write(0, 0, partial)), "invalid");
  assert.equal(await store.commit(write(0, 0, saved)), "committed");
  const reset = { ...write(1, 30, partial), resetFrom: saved };
  for (const bound of [{ ...replayThrough, offset: 10 }, { ...replayThrough, offset: -1 }, { ...replayThrough, prefixDigest: "missing" }]) {
    assert.equal(await store.commit({ ...reset, checkpoint: { ...partial, replayThrough: bound } }), "invalid");
  }
  assert.equal(await store.commit(reset), "committed");
  const next = { ...partial, offset: 20, prefixDigest: "d".repeat(64) };
  for (const bound of [undefined, { ...replayThrough, offset: 50 }, { ...replayThrough, prefixDigest: "e".repeat(64) }]) {
    assert.equal(await store.commit(write(2, 10, { ...next, replayThrough: bound })), "invalid");
  }
  assert.equal(await store.commit({ ...write(2, 10, { ...partial, replayThrough: undefined, parserState: claudeParserState(2) }),
    upgradeFromParserState: partial.parserState }), "invalid");
  assert.equal(await store.commit({ ...reset, expectedVersion: 2, expectedOffset: 10,
    resetFrom: { ...partial, replayThrough: undefined } }), "conflict");
  assert.equal(await store.commit(write(2, 10, next)), "committed");
  const end = { offset: replayThrough.offset, prefixDigest: replayThrough.prefixDigest, parserState: "complete" };
  assert.equal(await store.commit(write(3, 20, { ...end, prefixDigest: "e".repeat(64) })), "invalid");
  assert.equal(await store.commit(write(3, 20, end)), "committed");
  assert.deepEqual(await store.readCheckpoint(source), { version: 4, checkpoint: end });
});

test("after a rewrite, dated branches compare across file versions even when line numbers go backward", async () => {
  const store = new InMemoryCollectorStorage();
  const first = { offset: 300, parserState: "old", prefixDigest: "a".repeat(64) };
  assert.equal(await store.commit(batch(0, 0, {
    checkpoint: first, metadata: { branch: "main" }, branchObservation: { sourceOrder: 90, at: "2026-05-02T00:00:00Z" },
  })), "committed");
  const second = { offset: 30, parserState: "rebuilt", prefixDigest: "b".repeat(64) };
  assert.equal(await store.commit(batch(1, 300, {
    resetFrom: first, checkpoint: second, metadata: { branch: "old" },
    branchObservation: { sourceOrder: 3, at: "2026-05-01T00:00:00Z" },
  })), "committed");
  assert.equal((await store.readSession(source))?.metadata.branch, "main");
  assert.equal(await store.commit(batch(2, 30, {
    checkpoint: { ...second, offset: 40, prefixDigest: "c".repeat(64) }, metadata: { branch: "topic" },
    branchObservation: { sourceOrder: 4, at: "2026-05-03T00:00:00Z" },
  })), "committed");
  assert.equal((await store.readSession(source))?.metadata.branch, "topic");
});
