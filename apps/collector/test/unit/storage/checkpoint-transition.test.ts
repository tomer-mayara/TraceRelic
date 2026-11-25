import assert from "node:assert/strict";
import { test } from "node:test";
import type { Checkpoint } from "@tracerelic/collector/storage";
import { CheckpointTransition } from "#src/storage/checkpoint-transition";
import { batch, claudeParserState, codexSource } from "../../fixtures/collector-storage-fixture.ts";

test("a Claude parser upgrade accepts replay occurrences only under a digest", () => {
  for (const [key, failure] of [["a".repeat(64), undefined], ["not-a-digest", "invalid"]] as const) {
    const current: Checkpoint = { offset: 10, parserState: claudeParserState(1, { [key]: 1 }) };
    const upgrade = batch(1, 10, {
      checkpoint: { offset: 10, parserState: claudeParserState(2, { [key]: 1 }) }, upgradeFromParserState: current.parserState,
    });
    assert.equal(new CheckpointTransition(upgrade, current).failure(), failure);
  }
});

test("a fork position names its inherited bytes only with a digest", () => {
  for (const [prefixDigest, failure] of [["a".repeat(64), undefined], ["not-a-digest", "invalid"]] as const) {
    const codexFork = { parentSessionId: "parent", inheritedThrough: { offset: 5, lineNumber: 1, prefixDigest } };
    const checkpoint = { offset: 10, parserState: "{}", prefixDigest: "b".repeat(64), codexFork };
    assert.equal(new CheckpointTransition(batch(0, 0, { source: codexSource, checkpoint }), undefined).failure(), failure);
  }
});
