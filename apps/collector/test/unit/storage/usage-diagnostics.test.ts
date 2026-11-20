import assert from "node:assert/strict";
import { test } from "node:test";
import type { ByteRange, UsageDiagnostic } from "../../../src/storage/collector-storage.ts";
import { batch, codexParserState, codexSource, planning, request, source } from "../../fixtures/collector-storage-fixture.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";

test("damaged line ranges retain their location and keep coverage partial after the first measurement", async () => {
  for (const provider of [codexSource, source]) {
    const store = new InMemoryCollectorStorage();
    const stream = { ...provider, installationId: "desktop" };
    const diagnostic = { code: "malformed-transcript-line", sourceOrder: 2, byteRange: { startOffset: 3, endOffset: 10 } } as const;
    const incoming = { ...diagnostic, text: "private row", byteRange: { ...diagnostic.byteRange, fragment: "private bytes" } };
    const first = batch(0, 0, { source: stream, usageDiagnostics: [incoming, incoming] });
    assert.equal(await store.commit(first), "committed");
    const view = await store.readSession(stream);
    assert(view);
    const expected = { ...diagnostic, streamId: stream.streamId, installationId: stream.installationId };
    assert.deepEqual(view.usageDiagnostics, [expected]);
    assert.deepEqual([view.coverage, view.observedTotalTokens], ["unknown", null]);
    assert.equal(await store.commit(batch(1, 10, { source: stream, usage: [request()] })), "committed");
    const measured = await store.readSession(stream);
    assert.deepEqual([measured?.coverage, measured?.observedTotalTokens], ["partial", 42]);
    assert.deepEqual(measured?.usageDiagnostics, [expected]);
  }
});

test("storage rejects a bad diagnostic range atomically and accepts Codex loss codes only for Codex", async () => {
  const store = new InMemoryCollectorStorage();
  assert.equal(await store.commit(batch(0, 0, { source: codexSource, usage: [request()] })), "committed");
  const before = await store.readSession(codexSource);
  const checkpoint = await store.readCheckpoint(codexSource);
  const report = (byteRange?: ByteRange) => ({ code: "codex-counter-reset" as const, sourceOrder: 3, byteRange });
  for (const range of [
    undefined, { startOffset: 4, endOffset: 4 }, { startOffset: 6, endOffset: 5 },
    { startOffset: -1, endOffset: 7 }, { startOffset: 11.5, endOffset: 12 }, { startOffset: 12, endOffset: 21 },
    { startOffset: 0, endOffset: Number.MAX_SAFE_INTEGER + 1 }, null,
  ]) {
    const diagnostic = report(range as ByteRange);
    const invalid = batch(1, 10, { source: codexSource, messages: [planning], usageDiagnostics: [diagnostic] });
    assert.equal(await store.commit(invalid), "invalid");
  }
  assert.deepEqual(await store.readSession(codexSource), before);
  assert.deepEqual(await store.readCheckpoint(codexSource), checkpoint);
  const range = { startOffset: 10, endOffset: 20 };
  const diagnostics: UsageDiagnostic[] = [report(range), { ...report(range), code: "unsupported-codex-usage" }];
  for (const diagnostic of diagnostics) {
    assert.equal(await store.commit(batch(0, 0, {
      checkpoint: { offset: 20, parserState: "{}" }, usageDiagnostics: [diagnostic],
    })), "invalid");
  }
  const valid = batch(1, 10, { source: codexSource, messages: [planning], usageDiagnostics: diagnostics });
  assert.equal(await store.commit(valid), "committed");
  assert.equal(await store.commit(valid), "conflict");
  assert.equal((await store.readSession(codexSource))?.coverage, "partial");
});

test("a ranged diagnostic enriches a prior line-only observation and distinguishes later rewritten ranges", async () => {
  const store = new InMemoryCollectorStorage();
  const old = { code: "unsupported-claude-cache-breakdown", sourceOrder: 3 } as const;
  const located = { ...old, byteRange: { startOffset: 6, endOffset: 8 } };
  const shifted = { ...old, byteRange: { startOffset: 7, endOffset: 10 } };
  const first = batch(0, 0, { usageDiagnostics: [old], usage: [request()] });
  assert.equal(await store.commit(first), "committed");
  const reset = batch(1, 10, {
    resetFrom: first.checkpoint, checkpoint: { offset: 12, parserState: "{}", prefixDigest: "a".repeat(64) },
    usageDiagnostics: [located, located],
  });
  assert.equal(await store.commit(reset), "committed");
  assert.equal(await store.commit({ ...reset, expectedVersion: 2, expectedOffset: 12, resetFrom: reset.checkpoint,
    usageDiagnostics: [shifted, old, located],
  }), "committed");
  const view = await store.readSession(source);
  assert.deepEqual(view?.usageDiagnostics, [located, shifted].map(entry => ({ ...entry, streamId: source.streamId })));
  assert.equal(view.coverage, "reported");
});

test("Codex can backfill a text-only checkpoint at its accepted byte while awaiting a baseline", async () => {
  const store = new InMemoryCollectorStorage();
  const old = codexParserState(1);
  const first = batch(0, 0, { source: codexSource, messages: [planning], checkpoint: { offset: 10, parserState: old } });
  assert.equal(await store.commit(first), "committed");
  const next = JSON.parse(codexParserState(2));
  next.version = 4;
  const upgrade = batch(1, 10, { source: codexSource, upgradeFromParserState: old, checkpoint: first.checkpoint });
  const write = (state: unknown) => store.commit({ ...upgrade, checkpoint: { offset: 10, parserState: JSON.stringify(state) } });
  assert.equal(await write(next), "invalid");
  next.decoder.usage.awaitingBaseline = true;
  assert.equal(await write({ ...next, version: 2 }), "invalid");
  assert.equal(await write({ ...next, replayOccurrences: {} }), "invalid");
  assert.equal(await write({ ...next, decoder: { ...next.decoder, chat: {} } }), "invalid");
  assert.equal(await write(next), "committed");
  assert.deepEqual((await store.readSession(codexSource))?.messages, [planning]);
});
