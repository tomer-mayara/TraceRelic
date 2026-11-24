import assert from "node:assert/strict";
import { test } from "node:test";
import type { CorrectionBatchFields, SavedDecoder, UsageCorrection } from "@tracerelic/collector/scan";
import type { Checkpoint } from "@tracerelic/collector/storage";
import { TranscriptCursor } from "#src/scan/transcript-cursor";
import { CorrectingFormat, MockFormat, MockTranscript } from "../../fixtures/mock-scan-provider.ts";

const texts = ["Plan search", "Use an index", "Measure latency"];
const scannerFields = ["offset", "parserState", "prefixDigest", "evidenceVersion"];

/** The checkpoints that a cursor writes when it reads the source from byte zero. */
async function checkpoints(source: MockTranscript, format: MockFormat): Promise<Checkpoint[]> {
  const cursor = await TranscriptCursor.restore(source, null, format);
  const written: Checkpoint[] = [];
  for await (const { checkpoint } of cursor.read(source)) written.push(checkpoint);
  return written;
}

test("each checkpoint that the cursor writes has the checkpoint fields of its format after the fields of the scanner", async () => {
  const source = new MockTranscript("/mock/one.jsonl", "one", texts);
  const codexFork = { parentSessionId: "parent" };
  const written = await checkpoints(source, new CorrectingFormat({ codexFork }));
  assert.deepEqual(written.map(checkpoint => Object.keys(checkpoint)), texts.map(() => [...scannerFields, "codexFork"]));
  assert(written.every(checkpoint => checkpoint.codexFork === codexFork));
  const marked = await checkpoints(source, new CorrectingFormat({ claudeCallOrigins: true }));
  assert.deepEqual(marked.map(checkpoint => [Object.keys(checkpoint), checkpoint.claudeCallOrigins]),
    texts.map(() => [[...scannerFields, "claudeCallOrigins"], true]));
  const plain = await checkpoints(source, new MockFormat());
  assert.deepEqual(plain.map(checkpoint => Object.keys(checkpoint)), texts.map(() => scannerFields));
});

test("reconcileUsage returns nothing when the format has no correction or has none for the accepted checkpoint", async () => {
  const source = new MockTranscript("/mock/one.jsonl", "one", texts);
  const [, accepted] = await checkpoints(source, new MockFormat());
  assert.equal(await TranscriptCursor.reconcileUsage(source, accepted, new MockFormat()), undefined);
  const asked: Checkpoint[] = [];
  const format = new CorrectingFormat({ claudeCallOrigins: true }, checkpoint => {
    asked.push(checkpoint);
    return undefined;
  });
  assert.equal(await TranscriptCursor.reconcileUsage(source, accepted, format), undefined);
  assert.equal(asked.length, 1);
  assert.equal(asked[0], accepted);
});

test("a correction that gives the corrected checkpoint gets the usage of the accepted bytes, that checkpoint and its batch fields", async () => {
  const source = new MockTranscript("/mock/one.jsonl", "one", texts);
  const [, accepted] = await checkpoints(source, new MockFormat());
  const corrected = { ...accepted, claudeCallOrigins: true as const };
  const received: [SavedDecoder | undefined, object, unknown][] = [];
  const format = new CorrectingFormat({ claudeCallOrigins: true }, checkpoint => ({
    accepted: (saved, reread, sourceFormat) => {
      received.push([saved, reread.snapshot(), sourceFormat]);
      return { checkpoint: corrected };
    },
    batchFields: { backfillClaudeOriginsFrom: checkpoint },
  }));

  const batch = await TranscriptCursor.reconcileUsage(source, accepted, format);

  assert(batch);
  assert.deepEqual(batch.usage.map(call => call.id), ["call:1", "call:2"]);
  assert.deepEqual(batch.messages, []);
  assert.equal("metadata" in batch, false);
  assert.equal(batch.checkpoint, corrected);
  assert.equal(batch.backfillClaudeOriginsFrom, accepted);
  assert.deepEqual(Object.keys(batch).slice(-2), ["checkpoint", "backfillClaudeOriginsFrom"]);
  assert.deepEqual(received.map(([saved, reread]) => [saved?.version, saved?.decoder, reread]), [[2, { decoded: 2 }, { decoded: 2 }]]);
  assert.equal(received[0][2], format);
});

test("a correction that gives a parser gets the checkpoint of that parser at the accepted byte, and the known parent", async () => {
  const source = new MockTranscript("/mock/one.jsonl", "one", texts);
  const [, accepted] = await checkpoints(source, new MockFormat());
  const codexFork = { parentSessionId: "parent" };
  const format = new CorrectingFormat({ codexFork }, checkpoint => ({
    parentSessionId: "parent",
    accepted: () => ({ parser: new MockFormat().resume({ decoded: 7 }) }),
    batchFields: { reconcileCodexForkFrom: checkpoint },
  }));

  const batch = await TranscriptCursor.reconcileUsage(source, accepted, format);

  assert(batch);
  assert.deepEqual(batch.usage.map(call => call.id), ["call:1", "call:2"]);
  assert.deepEqual(batch.metadata, { parentSessionId: "parent" });
  assert.deepEqual(batch.checkpoint, {
    offset: accepted.offset, parserState: JSON.stringify({ version: 2, lineNumber: 2, decoder: { decoded: 7 } }),
    prefixDigest: accepted.prefixDigest, evidenceVersion: 1, codexFork,
  });
  assert.deepEqual(Object.keys(batch.checkpoint), [...scannerFields, "codexFork"]);
  assert.equal(batch.reconcileCodexForkFrom, accepted);
  assert.deepEqual(Object.keys(batch).slice(-2), ["checkpoint", "reconcileCodexForkFrom"]);
});

test("a correction can add only a batch field in which a provider names the checkpoint that it replaces", () => {
  // The typecheck fails unless this object has each field of CorrectionBatchFields and no other field.
  const fields: Record<keyof CorrectionBatchFields, true> = { reconcileCodexForkFrom: true, backfillClaudeOriginsFrom: true };
  assert.equal(Object.keys(fields).length, 2);
  const checkpoint: Checkpoint = { offset: 0, parserState: "{}" };
  const rejected: UsageCorrection<unknown>[] = [
    // @ts-expect-error A correction cannot replace the checkpoint of the batch.
    { accepted: (_saved, reread) => ({ parser: reread }), batchFields: { checkpoint } },
    // @ts-expect-error A correction cannot add messages to the batch.
    { accepted: (_saved, reread) => ({ parser: reread }), batchFields: { messages: [] } },
    // @ts-expect-error Only the scanner resets a stream.
    { accepted: (_saved, reread) => ({ parser: reread }), batchFields: { resetFrom: checkpoint } },
    // @ts-expect-error Only the scanner repairs the evidence of a checkpoint.
    { accepted: (_saved, reread) => ({ parser: reread }), batchFields: { repairEvidenceFrom: checkpoint } },
  ];
  assert.equal(rejected.length, 4);
});
