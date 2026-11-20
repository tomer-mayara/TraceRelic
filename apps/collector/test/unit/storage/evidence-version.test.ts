import assert from "node:assert/strict";
import { test } from "node:test";
import type { Checkpoint } from "../../../src/storage/collector-storage.ts";
import { batch, claudeParserState, codexParserState, codexSource, source } from "../../fixtures/collector-storage-fixture.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";

for (const verified of [false, true]) {
  test(`same-generation writes cannot ${verified ? "remove" : "introduce"} the history evidence marker`, async () => {
    const store = new InMemoryCollectorStorage();
    for (const stream of [source, codexSource]) {
      const claude = stream.harness === "claude";
      const parserState = claude ? claudeParserState(1) : codexParserState(1);
      const accepted: Checkpoint = { offset: 20, parserState, prefixDigest: "a".repeat(64), evidenceVersion: verified ? 1 : undefined };
      assert.equal(await store.commit(batch(0, 0, { source: stream, checkpoint: accepted })), "committed");
      const before = await store.readCheckpoint(stream);
      const next: Checkpoint = { ...accepted, parserState: claude ? claudeParserState(2) : codexParserState(2), evidenceVersion: verified ? undefined : 1 };
      const followup = batch(1, 20, { source: stream, checkpoint: next });
      const correction = claude ? { backfillClaudeOriginsFrom: accepted, checkpoint: { ...next, claudeCallOrigins: true as const } }
        : { reconcileCodexForkFrom: accepted, checkpoint: { ...next, codexFork: { parentSessionId: "parent" } } };
      assert.equal(await store.commit({ ...followup, upgradeFromParserState: parserState }), "invalid");
      assert.equal(await store.commit({ ...followup, ...correction }), "invalid");
      assert.equal(await store.commit({ ...followup, checkpoint: { ...next, offset: 21 } }), "invalid");
      assert.deepEqual(await store.readCheckpoint(stream), before);
      assert.equal(await store.commit({ ...followup, checkpoint: { ...accepted, offset: 21 } }), "committed");
    }
  });
}
