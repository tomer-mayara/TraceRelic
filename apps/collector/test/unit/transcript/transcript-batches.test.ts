import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { JsonlRecords } from "#src/transcript/jsonl-records";
import { TranscriptBatches } from "#src/transcript/transcript-batches";
import { TranscriptBatchesFixture as F } from "../../fixtures/transcript-batches-fixture.ts";

const source = new TranscriptBatches(new JsonlRecords()).transcriptSource(F.emptyFile());
const start = { offset: 0, lineNumber: 0 };

test("readBatches accepts a batch byte limit that is a positive safe integer and rejects each other limit", async () => {
  for (const limit of [1, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(await Array.fromAsync(source.readBatches(start, limit)), [], inspect(limit));
  }
  for (const limit of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(Array.fromAsync(source.readBatches(start, limit)),
      { name: "RangeError", message: "Expected a positive batch byte limit" }, inspect(limit));
  }
});

test("readBatches accepts byte and line positions that are nonnegative safe integers and rejects each other position", async () => {
  const last = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(await Array.fromAsync(source.readBatches({ offset: last, lineNumber: last }, 1, last)), []);
  for (const [position, end] of [[{ offset: -1, lineNumber: 0 }, 0], [{ offset: 0.5, lineNumber: 0 }, 0], [{ offset: 0, lineNumber: -1 }, 0],
    [{ offset: 0, lineNumber: 0.5 }, 0], [start, -1], [start, last + 1]] as const) {
    await assert.rejects(Array.fromAsync(source.readBatches(position, 1, end)),
      { name: "RangeError", message: "Expected nonnegative byte and line positions" }, inspect({ position, end }));
  }
});
