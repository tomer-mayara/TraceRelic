import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, open, utimes, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { GlobalConfig } from "@tracerelic/collector/config";
import { LocalLLMHistoryClaude, LocalLLMHistoryCodex } from "@tracerelic/collector/history";
import { ClaudeProjectFixture as Claude } from "../../fixtures/claude-project-fixture.ts";
import { CodexRolloutFixture as Rollout } from "../../fixtures/codex-rollout-fixture.ts";

test("verifies several positions in one pass and resumes each session from the verified hash", async t => {
  const fixture = await Claude.create();
  t.after(() => fixture.close());
  const rows = [
    Buffer.from(JSON.stringify({ sessionId: "first", text: "é" }) + "\r\n"),
    Buffer.from([0xff, 0x0d, 0x0a, 0x0a]),
    Buffer.from(JSON.stringify({ sessionId: "second", text: "x".repeat(70 * 1024) }) + "\n"),
    Buffer.from(JSON.stringify({ sessionId: "first", text: "done" }) + "\n"),
  ];
  const complete = Buffer.concat(rows);
  const bytes = Buffer.concat([complete, Buffer.from('{"unfinished":')]);
  const path = await fixture.write("project", "both", []);
  await writeFile(path, bytes);
  const reader = new LocalLLMHistoryClaude(new GlobalConfig("/codex", fixture.home));
  const [first, second] = await Array.fromAsync(reader.discoverSources());
  assert.deepEqual([first.sessionId, second.sessionId], ["first", "second"]);
  const throughFirst = rows[0].length;
  const throughSecond = throughFirst + rows[1].length + rows[2].length;
  const offsets = [0, throughFirst, throughSecond];
  const digest = (offset: number) => createHash("sha256").update(bytes.subarray(0, offset)).digest("hex");

  const handle = await open(path, "r");
  t.after(() => handle.close());
  const reads = t.mock.method(Object.getPrototypeOf(handle) as typeof handle, "read");
  const bytesRead = async () => {
    const chunks = await Promise.all(reads.mock.calls.map(call => call.result));
    return chunks.reduce((total, chunk) => {
      assert(chunk);
      return total + chunk.bytesRead;
    }, 0);
  };
  const verified = await first.prefixDigests(offsets);
  assert.deepEqual(verified, offsets.map(offset => ({ offset, prefixDigest: digest(offset) })));
  assert.equal(await bytesRead(), throughSecond);

  for (const [source, offset, lineNumber] of [[first, throughFirst, 1], [second, throughSecond, 4]] as const) {
    reads.mock.resetCalls();
    const batches = await Array.fromAsync(source.readBatches({ offset, lineNumber }, 4096));
    assert.equal(await bytesRead(), bytes.length - offset);
    assert.deepEqual(batches.map(batch => batch.prefixDigest), batches.map(batch => digest(batch.next.offset)));
    assert.deepEqual(batches.at(-1)?.next, { offset: complete.length, lineNumber: 5 });
  }
});

test("a same-size edit invalidates a captured prefix even when the tail is identical", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const header = Rollout.header("shared");
  const before = [{ text: "red" }, { text: "same tail" }];
  const after = [{ text: "new" }, before[1]];
  const path = await fixture.write([header, ...before]);
  await utimes(path, new Date(0), new Date(0));
  const reader = new LocalLLMHistoryCodex(new GlobalConfig(fixture.home));
  const [original] = await Array.fromAsync(reader.discoverSources());
  const [oldPrefix] = await original.prefixDigests([original.fileSize]);
  await fixture.write([header, ...after]);
  await assert.rejects(original.prefixDigests([original.fileSize]), { name: "TranscriptChangedError", sourceFile: path });
  await assert.rejects(Array.fromAsync(original.readBatches({ offset: 0, lineNumber: 0 })), { name: "TranscriptChangedError" });
  const [updated] = await Array.fromAsync(reader.discoverSources());
  const [newPrefix] = await updated.prefixDigests([updated.fileSize]);
  assert.equal(oldPrefix.offset, newPrefix.offset);
  assert.notEqual(oldPrefix.prefixDigest, newPrefix.prefixDigest);
  // Appends can finish while this scan reads its captured bytes.
  await appendFile(path, "\n");
  assert.deepEqual(await updated.prefixDigests([updated.fileSize]), [newPrefix]);
  await writeFile(path, [header, ...before].map(row => JSON.stringify(row)).join("\n") + "\n\n");
  await utimes(path, new Date(0), new Date(0));
  await assert.rejects(updated.prefixDigests([updated.fileSize]), { name: "TranscriptChangedError", sourceFile: path });
});
