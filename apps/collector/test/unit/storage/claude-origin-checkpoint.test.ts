import assert from "node:assert/strict";
import { test } from "node:test";
import type { Batch } from "@tracerelic/collector/storage";
import { batch, claudeParserState, codexSource, planning, request, source } from "../../fixtures/collector-storage-fixture.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";

test("backfills Claude origins only at the exact accepted checkpoint", async () => {
  const store = new InMemoryCollectorStorage();
  const saved = { offset: 10, parserState: claudeParserState(2), prefixDigest: "a".repeat(64) };
  const checkpoint = { ...saved, claudeCallOrigins: true as const };
  const backfill = batch(1, 10, { backfillClaudeOriginsFrom: saved, checkpoint });
  assert.equal(await store.commit(batch(0, 0, { checkpoint: saved, messages: [planning] })), "committed");
  const before = await store.readSession(source);
  for (const fields of [
    { checkpoint: { ...checkpoint, offset: 11 } }, { checkpoint: { ...checkpoint, prefixDigest: "b".repeat(64) } },
    { checkpoint: { ...checkpoint, parserState: claudeParserState(2, { ["a".repeat(64)]: 1 }) } },
    { checkpoint: saved }, { resetFrom: saved }, { upgradeFromParserState: saved.parserState },
    { messages: [planning] }, { usage: [request()] }, { metadata: { cwd: "/elsewhere" } },
  ]) assert.equal(await store.commit({ ...backfill, ...fields }), "invalid");
  assert.equal(await store.commit({ ...backfill, backfillClaudeOriginsFrom: { ...saved, offset: 9 } }), "conflict");
  assert.deepEqual(await store.readSession(source), before);
  assert.equal(await store.commit(backfill), "committed");
  assert.deepEqual(await store.readCheckpoint(source), { version: 2, checkpoint });
  assert.deepEqual(await store.readSession(source), before);
  assert.equal(await store.commit({ ...backfill, expectedVersion: 2, backfillClaudeOriginsFrom: checkpoint }), "invalid");
  assert.equal(await store.commit(batch(2, 10, { checkpoint: { ...saved, offset: 20 } })), "invalid");
});

test("an origin marker requires Claude and a digest", async () => {
  const store = new InMemoryCollectorStorage();
  for (const fields of [
    { checkpoint: { offset: 10, parserState: "{}", claudeCallOrigins: true } },
    { source: codexSource, checkpoint: { offset: 10, parserState: "{}", prefixDigest: "a".repeat(64), claudeCallOrigins: true } },
    { checkpoint: { offset: 10, parserState: "{}", prefixDigest: "a".repeat(64), claudeCallOrigins: false } },
  ]) assert.equal(await store.commit({ ...batch(0, 0), ...fields } as Batch), "invalid");
});
