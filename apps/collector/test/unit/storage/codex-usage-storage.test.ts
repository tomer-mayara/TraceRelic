import assert from "node:assert/strict";
import { test } from "node:test";
import type { Usage } from "../../../src/storage/collector-storage.ts";
import {
  batch, codexMeasurement, codexParserState, codexSource, codexWindow, planning, request, source,
} from "../../fixtures/collector-storage-fixture.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";

test("verified windows count their changes once alongside calls already recorded by ID", async () => {
  const store = new InMemoryCollectorStorage();
  const first = codexMeasurement("first", "interval", 120);
  const known = { ...codexMeasurement("known", "call", 20), model: "model", turnId: "turn", requestId: "request" };
  const last = codexMeasurement("last", "call", 30);
  const remainder = codexMeasurement("remainder", "interval", 30);
  assert.equal(await store.commit(batch(0, 0, { source: codexSource, usageWindows: [codexWindow(0, 120, first)] })), "committed");
  assert.equal(await store.commit(batch(1, 10, { source: codexSource, usage: [known] })), "committed");
  assert.equal((await store.readSession(codexSource))?.observedTotalTokens, 140);
  assert.equal(await store.commit(batch(2, 20, {
    source: codexSource, usageWindows: [codexWindow(120, 200, known, last, remainder)],
  })), "committed");
  const view = await store.readSession(codexSource);
  assert.deepEqual(view?.usage, [first, known, last, remainder]);
  assert.equal(view?.observedTotalTokens, 200);
  assert.equal(view?.coverage, "reported");
});

test("only typed calls carry attribution and legacy usage can retain its recorded model", async () => {
  const store = new InMemoryCollectorStorage();
  const call = codexMeasurement("measured", "call", 50);
  const invalid: Partial<Usage>[] = [
    { kind: "total" as Usage["kind"] }, { kind: "interval", model: "model" },
    { kind: "interval", turnId: "turn" }, { kind: "interval", requestId: "request" },
    { kind: undefined, turnId: "turn" }, { kind: undefined, requestId: "request" },
    { turnId: "" }, { requestId: "" }, { model: 1 as unknown as string },
    { reasoningTokens: null as unknown as number },
  ];
  for (const fields of invalid) {
    const usage = { ...call, ...fields };
    assert.equal(await store.commit(batch(0, 0, { source: codexSource, usage: [usage] })), "invalid", JSON.stringify(fields));
    assert.equal(await store.commit(batch(0, 0, {
      source: codexSource, usageWindows: [codexWindow(0, 50, usage)],
    })), "invalid", JSON.stringify(fields));
  }
  assert.deepEqual(await store.readCheckpoint(codexSource), { version: 0, checkpoint: null });
  assert.equal(await store.readSession(codexSource), null);
  const legacy = request({ model: "legacy-model" });
  assert.equal(await store.commit(batch(0, 0, { source: codexSource, usage: [legacy] })), "committed");
  assert.deepEqual((await store.readSession(codexSource))?.usage, [legacy]);
});

test("a window replacement and its checkpoint publish together and survive coarse replay", async () => {
  const store = new InMemoryCollectorStorage();
  const copy = { ...codexSource, installationId: "other" };
  const coarse = codexWindow(0, 200, codexMeasurement("coarse", "interval", 200));
  const earlier = codexWindow(0, 120, codexMeasurement("earlier", "interval", 120));
  const later = codexWindow(120, 200, codexMeasurement("later", "call", 80));
  const write = batch(0, 0, { source: codexSource, messages: [planning], usageWindows: [structuredClone(coarse)] });
  assert.equal(await store.commit(write), "committed");
  const view = await store.readSession(codexSource);
  assert.deepEqual(view?.usage, coarse.parts);
  assert.equal(view?.observedTotalTokens, 200);
  const replacement = batch(1, 0, {
    source: copy, metadata: { branch: "replacement" }, messages: [{ ...planning, id: "second" }],
    usageWindows: [earlier, later],
  });
  const wrongCount = { ...later, parts: [{ ...later.parts[0], inputTokens: 65 }] };
  for (const proposal of [
    { ...replacement, usageWindows: [earlier, wrongCount] },
    { ...replacement, usage: [{ ...later.parts[0], inputTokens: 65 }] },
  ]) {
    assert.equal(await store.commit(proposal), "invalid");
    assert.deepEqual(await store.readSession(codexSource), view);
    assert.deepEqual(await store.readCheckpoint(copy), { version: 1, checkpoint: null });
    assert.deepEqual(await store.readCheckpoint(codexSource), { version: 1, checkpoint: write.checkpoint });
  }
  assert.equal(await store.commit(replacement), "committed");
  // The caller still owns the batch and can mutate it as soon as the commit finishes.
  assert.ok(replacement.usageWindows);
  replacement.usageWindows[0].start.inputTokens = 500;
  replacement.usageWindows[1].parts[0].inputTokens = 500;
  assert.equal(await store.commit(batch(2, 10, { source: codexSource, usageWindows: [coarse] })), "committed");
  const detailed = await store.readSession(codexSource);
  assert.deepEqual(detailed?.usage.map(record => [record.id, record.inputTokens + record.outputTokens]), [
    ["earlier", 120], ["later", 80],
  ]);
  assert.equal(detailed?.observedTotalTokens, 200);
  assert.equal(detailed?.coverage, "reported");
  assert.deepEqual(detailed?.metadata, replacement.metadata);
  assert.deepEqual(detailed?.messages, [planning, ...replacement.messages]);
  assert.deepEqual(await store.readCheckpoint(copy), { version: 3, checkpoint: replacement.checkpoint });
});

test("a second copy cannot double-charge a separate call inside an already published interval", async () => {
  const store = new InMemoryCollectorStorage();
  const copy = { ...codexSource, installationId: "copy" };
  const coarse = codexWindow(0, 200, codexMeasurement("coarse", "interval", 200));
  const known = codexMeasurement("known", "call", 20);
  const tail = codexMeasurement("tail", "interval", 180);
  assert.equal(await store.commit(batch(0, 0, { source: codexSource, usageWindows: [coarse] })), "committed");
  const anchor = { usageId: known.id, historyId: coarse.historyId, after: { ...coarse.start } };
  assert.equal(await store.commit(batch(1, 0, { source: copy, usage: [known], usageAnchors: [anchor] })), "committed");
  const pending = await store.readSession(copy);
  assert.deepEqual(pending?.usage, coarse.parts);
  assert.equal(pending?.observedTotalTokens, 200);
  assert.equal(pending?.coverage, "reported");
  anchor.after.inputTokens = 999;
  assert.equal(await store.commit(batch(2, 10, { source: codexSource, usageWindows: [coarse] })), "committed");
  assert.deepEqual(await store.readSession(copy), pending);
  assert.equal(await store.commit(batch(3, 10, { source: copy, usageWindows: [codexWindow(0, 200, known, tail)] })), "committed");
  const detailed = await store.readSession(copy);
  assert.deepEqual(detailed?.usage, [known, tail]);
  assert.equal(detailed?.observedTotalTokens, 200);
  assert.equal(detailed?.coverage, "reported");
});

test("a last-only report following a rewrite can overlap the same stream's earlier anonymous interval", async () => {
  const store = new InMemoryCollectorStorage();
  const coarse = codexWindow(0, 200, codexMeasurement("coarse", "interval", 200));
  const checkpoint = { offset: 10, parserState: "old", prefixDigest: "a".repeat(64) };
  assert.equal(await store.commit(batch(0, 0, { source: codexSource, usageWindows: [coarse], checkpoint })), "committed");
  const replacement = { offset: 5, parserState: "replacement", prefixDigest: "b".repeat(64) };
  assert.equal(await store.commit(batch(1, 10, { source: codexSource, resetFrom: checkpoint, checkpoint: replacement })), "committed");
  const call = { ...codexMeasurement("request", "call", 20), requestId: "request" };
  const anchor = { usageId: call.id, historyId: coarse.historyId };
  assert.equal(await store.commit(batch(2, 5, {
    source: codexSource, checkpoint: { ...replacement, offset: 15, prefixDigest: "c".repeat(64) }, usage: [call], usageAnchors: [anchor],
  })), "committed");
  assert.deepEqual((await store.readSession(codexSource))?.usage, coarse.parts);
  const tail = codexMeasurement("tail", "interval", 180);
  assert.equal(await store.commit(batch(3, 15, {
    source: codexSource, checkpoint: { ...replacement, offset: 25, prefixDigest: "d".repeat(64) },
    usageWindows: [codexWindow(0, 200, call, tail)],
  })), "committed");
  const view = await store.readSession(codexSource);
  assert.deepEqual(view?.usage, [call, tail]);
  assert.equal(view.observedTotalTokens, 200);
});

test("a rewritten coarse total cannot withdraw a previously published native call", async () => {
  const store = new InMemoryCollectorStorage();
  const coarse = codexWindow(0, 30, codexMeasurement("anonymous", "interval", 30));
  const call = { ...codexMeasurement("request", "call", 120), requestId: "request" };
  const checkpoint = { offset: 100, parserState: "old", prefixDigest: "a".repeat(64) };
  assert.equal(await store.commit(batch(0, 0, {
    source: codexSource, checkpoint, usage: [call], usageAnchors: [{ usageId: call.id, historyId: coarse.historyId }],
  })), "committed");
  const replacement = { offset: 10, parserState: "replacement", prefixDigest: "b".repeat(64) };
  assert.equal(await store.commit(batch(1, 100, { source: codexSource, resetFrom: checkpoint, checkpoint: replacement })), "committed");
  assert.equal(await store.commit(batch(2, 10, {
    source: codexSource, checkpoint: { ...replacement, offset: 20, prefixDigest: "c".repeat(64) }, usageWindows: [coarse],
  })), "committed");
  const view = await store.readSession(codexSource);
  assert.deepEqual(view?.usage, [call]);
  assert.equal(view.observedTotalTokens, 120);
  assert.equal(view.coverage, "partial");
  assert.equal(await store.commit(batch(3, 20, {
    source: codexSource, checkpoint: { ...replacement, offset: 30, prefixDigest: "d".repeat(64) },
    usageWindows: [codexWindow(30, 150, call)],
  })), "committed");
  const resolved = await store.readSession(codexSource);
  assert.deepEqual(resolved?.usage, [call, ...coarse.parts]);
  assert.equal(resolved.observedTotalTokens, 150);
});

test("each anchor needs a valid history and an identified call in the same batch", async () => {
  const store = new InMemoryCollectorStorage();
  const call = codexMeasurement("call", "call", 10);
  const good = { usageId: call.id, historyId: "history" };
  for (const fields of [
    { usageAnchors: [{ ...good, usageId: "" }] }, { usageAnchors: [{ ...good, historyId: "" }] },
    { usageAnchors: [{ ...good, usageId: "another" }] }, { usageAnchors: [{ ...good, after: { inputTokens: -1, outputTokens: 0 } }] },
    { usageAnchors: [{ ...good, after: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1 } }] },
    { usage: [{ ...call, kind: "interval" as const }], usageAnchors: [good] },
    { usage: [{ ...call, kind: undefined }], usageAnchors: [good] },
  ]) {
    assert.equal(await store.commit(batch(0, 0, { source: codexSource, usage: [call], ...fields })), "invalid", JSON.stringify(fields));
  }
  assert.deepEqual(await store.readCheckpoint(codexSource), { version: 0, checkpoint: null });
  assert.equal(await store.readSession(codexSource), null);
});

test("copies reporting the same native call retain its first time and position and add compatible fields", async () => {
  const copy = { ...codexSource, installationId: "copy" };
  const first = { ...codexMeasurement("known", "call", 20), requestId: "request", model: "model" };
  const repeat = { ...codexMeasurement("known", "call", 20), requestId: "request", at: "2026-01-02T00:00:00Z", turnId: "turn" };
  const other = codexMeasurement("other", "interval", 30);
  for (const windowFirst of [false, true]) {
    const store = new InMemoryCollectorStorage();
    const initial = windowFirst ? { usageWindows: [codexWindow(0, 50, other, first)] } : { usage: [other, first] };
    const replay = windowFirst ? { usage: [repeat] } : { usageWindows: [codexWindow(0, 50, other, repeat)] };
    assert.equal(await store.commit(batch(0, 0, { source: codexSource, ...initial })), "committed");
    assert.equal(await store.commit(batch(1, 0, { source: copy, ...replay })), "committed");
    const view = await store.readSession(codexSource);
    assert.deepEqual(view?.usage, [other, { ...first, turnId: "turn" }]);
    assert.equal(view?.observedTotalTokens, 50);
    assert.equal(view?.coverage, "reported");
    for (const fields of [{ model: "conflict" }, { inputTokens: 100 }, { requestId: "another" }]) {
      assert.equal(await store.commit(batch(2, 10, { source: copy, usage: [{ ...repeat, ...fields }] })), "invalid");
      assert.deepEqual(await store.readSession(codexSource), view);
    }
  }
});

test("a native Codex call ID identifies repeated measurements without a request ID", async () => {
  const earlier = codexMeasurement("call:native:" + "a".repeat(64), "call", 20);
  const copy = { ...codexSource, installationId: "copy" };
  const repeat = { ...earlier, at: "2026-01-02T00:00:00Z", model: "reported-model" };
  const store = new InMemoryCollectorStorage();
  assert.equal(await store.commit(batch(0, 0, { source: codexSource, usageWindows: [codexWindow(0, 20, earlier)] })), "committed");
  assert.equal(await store.commit(batch(1, 0, { source: copy, usage: [repeat] })), "committed");
  const view = await store.readSession(codexSource);
  assert.deepEqual(view?.usage, [{ ...earlier, model: repeat.model }]);
  assert.equal(view?.observedTotalTokens, 20);
  assert.equal(view?.coverage, "reported");
});

test("ordinary Codex observations retain strict equality at the same revision", async () => {
  const store = new InMemoryCollectorStorage();
  const call = { ...codexMeasurement("opaque-id", "call", 20), requestId: "request" };
  const copy = { ...codexSource, installationId: "copy" };
  assert.equal(await store.commit(batch(0, 0, { source: codexSource, usage: [call] })), "committed");
  for (const fields of [{ at: "2026-01-02T00:00:00Z" }, { turnId: "added" }]) {
    assert.equal(await store.commit(batch(1, 0, { source: copy, usage: [{ ...call, ...fields }] })), "invalid");
  }
  assert.deepEqual((await store.readSession(codexSource))?.usage, [call]);
  assert.deepEqual(await store.readCheckpoint(copy), { version: 1, checkpoint: null });
});

test("the same call in two disjoint windows has a measured amount and an unresolved gap", async () => {
  const store = new InMemoryCollectorStorage();
  const call = { ...codexMeasurement("call", "call", 20), requestId: "request" };
  assert.equal(await store.commit(batch(0, 0, {
    source: codexSource, usageWindows: [codexWindow(0, 20, call), codexWindow(20, 40, call)],
  })), "committed");
  const view = await store.readSession(codexSource);
  assert.deepEqual(view?.usage, [call]);
  assert.equal(view?.observedTotalTokens, 20);
  assert.equal(view?.coverage, "partial");
});

test("a Codex checkpoint accepts one conditional usage backfill at its current byte", async () => {
  for (const old of ["", "{}", " { } ", codexParserState(1)]) {
    const store = new InMemoryCollectorStorage();
    const initial = batch(0, 0, { source: codexSource, checkpoint: { offset: 10, parserState: old }, messages: [planning] });
    assert.equal(await store.commit(initial), "committed");
    const checkpoint = { offset: 10, parserState: codexParserState(2) };
    const measured = codexMeasurement("measured", "call", 50);
    const upgrade = batch(1, 10, { source: codexSource, checkpoint, upgradeFromParserState: old, usage: [measured] });
    assert.equal(await store.commit({ ...upgrade, expectedVersion: 0 }), "conflict");
    assert.equal(await store.commit({ ...upgrade, expectedOffset: 0 }), "conflict");
    assert.equal(await store.commit({ ...upgrade, upgradeFromParserState: old + " " }), "conflict");
    assert.deepEqual(await store.readCheckpoint(codexSource), { version: 1, checkpoint: initial.checkpoint });
    assert.deepEqual((await store.readSession(codexSource))?.usage, []);
    assert.equal(await store.commit(upgrade), "committed");
    assert.equal(await store.commit(upgrade), "conflict");
    assert.equal(await store.commit({ ...upgrade, expectedVersion: 2, upgradeFromParserState: checkpoint.parserState }), "invalid");
    assert.deepEqual(await store.readCheckpoint(codexSource), { version: 2, checkpoint });
    const view = await store.readSession(codexSource);
    assert.deepEqual(view?.messages, [planning]);
    assert.deepEqual(view?.usage, [measured]);
    assert.equal(view?.observedTotalTokens, 50);
  }
});

test("an upgrade rejects invalid parser envelopes, changed lines and ordinary appends", async () => {
  const store = new InMemoryCollectorStorage();
  const initial = { offset: 10, parserState: codexParserState(1) };
  const checkpoint = { offset: 10, parserState: codexParserState(2) };
  const fields = { source: codexSource, checkpoint, upgradeFromParserState: initial.parserState, usage: [request()] };
  assert.equal(await store.commit(batch(0, 0, { ...fields, checkpoint: { ...checkpoint, offset: 0 } })), "invalid");
  assert.equal(await store.commit(batch(0, 0, { source: codexSource, checkpoint: initial })), "committed");
  const view = await store.readSession(codexSource);
  for (const parserState of [
    "invalid", "[]", "{}", codexParserState(1), codexParserState(2, 0), codexParserState(2, 3), codexParserState(2, 11),
    '{"version":2,"lineNumber":2}', '{"version":2,"lineNumber":2,"decoder":{}}',
    '{"version":2,"lineNumber":2,"decoder":{"chat":{},"usage":[]}}',
    '{"version":2,"lineNumber":2,"decoder":{"chat":{"changed":true},"usage":{}}}',
    JSON.stringify({ ...JSON.parse(checkpoint.parserState), decoder: { ...JSON.parse(checkpoint.parserState).decoder, extra: {} } }),
  ]) {
    assert.equal(await store.commit(batch(1, 10, { ...fields, checkpoint: { offset: 10, parserState } })), "invalid", parserState);
  }
  for (const offset of [9, 11]) {
    assert.equal(await store.commit(batch(1, 10, { ...fields, checkpoint: { ...checkpoint, offset } })), "invalid");
  }
  for (const rewrite of [
    { messages: [planning] }, { metadata: { cwd: "/other" } },
    { metadata: { branch: "topic" }, branchObservation: { sourceOrder: 1 } },
  ]) {
    assert.equal(await store.commit(batch(1, 10, { ...fields, ...rewrite })), "invalid");
  }
  assert.equal(await store.commit(batch(1, 10, { ...fields, upgradeFromParserState: undefined })), "invalid");
  assert.deepEqual(await store.readCheckpoint(codexSource), { version: 1, checkpoint: initial });
  assert.deepEqual(await store.readSession(codexSource), view);

  for (const [stream, old] of [
    [source, codexParserState(1)],
    [codexSource, "broken"], [codexSource, '{"version":1,"lineNumber":2,"decoder":null}'],
    [codexSource, codexParserState(2)], [codexSource, '{"version":3,"lineNumber":2,"decoder":{}}'],
  ] as const) {
    const other = new InMemoryCollectorStorage();
    const before = { offset: 10, parserState: old };
    assert.equal(await other.commit(batch(0, 0, { source: stream, checkpoint: before })), "committed");
    assert.equal(await other.commit(batch(1, 10, { ...fields, source: stream, upgradeFromParserState: old })), "invalid", old);
    assert.deepEqual(await other.readCheckpoint(stream), { version: 1, checkpoint: before });
  }
});
