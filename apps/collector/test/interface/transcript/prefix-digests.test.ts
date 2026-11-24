import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, open, readFile, utimes, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { ClaudeHistory, CodexHistory } from "@tracerelic/collector/providers";
import { ClaudeProjectFixture as Claude } from "../../fixtures/claude-project-fixture.ts";
import { CodexRolloutFixture as Rollout } from "../../fixtures/codex-rollout-fixture.ts";
import { CapturedTranscriptFile } from "#src/transcript/captured-transcript-file";
import { JsonlRecords } from "#src/transcript/jsonl-records";
import { TranscriptBatches } from "#src/transcript/transcript-batches";

test("a record gets the digest of the file through its own line exactly when its selected file names it a conversation record", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const rows = [{ type: "user", text: "one" }, { type: "note", text: "two" }, { type: "assistant", text: "three" }, { type: "note", text: "four" }];
  const path = await fixture.write(rows);
  const bytes = await readFile(path);
  const jsonl = new JsonlRecords();
  const { file } = await jsonl.inspectFile(path, async () => {});
  const source = new TranscriptBatches(jsonl).transcriptSource({
    sessionId: "chat", file, harness: "codex", matches: () => true, isConversation: record => record.type === "note",
  });
  const entries = (await Array.fromAsync(source.readBatches({ offset: 0, lineNumber: 0 }))).flatMap(batch => batch.entries);
  const digest = (offset: number) => createHash("sha256").update(bytes.subarray(0, offset)).digest("hex");
  assert.deepEqual(entries.map(entry => entry.record), rows);
  assert.deepEqual(entries.map(entry => entry.recordPrefixDigest),
    [undefined, digest(entries[1].endOffset), undefined, digest(entries[3].endOffset)]);
  assert.deepEqual(entries.map(entry => "recordPrefixDigest" in entry), [false, true, false, true]);
});

test("a genuine append during discovery and again during batching keeps the selected bytes and avoids rereading them per batch", async t => {
  const root = await Rollout.create();
  t.after(() => root.close());
  const rows = [Rollout.header("one"), ...Array.from({ length: 30 }, (_, n) => ({ text: String(n) }))];
  const path = await root.write(rows);
  const before = await readFile(path);
  const { file } = await CapturedTranscriptFile.inspect(path, async chunks => {
    for await (const _chunk of chunks) { await appendFile(path, "\n"); break; }
  });
  assert.equal(file.fileSize, before.length);
  assert.equal(await file.completeEnd(), before.length);
  const source = (await Array.fromAsync(new CodexHistory(root.home).discoverSources()))[0];
  const batches = source.readBatches({ offset: 0, lineNumber: 0 }, 1)[Symbol.asyncIterator]();
  const first = await batches.next();
  assert(!first.done);
  await appendFile(path, '{"new":true}\n');
  const handle = await open(path, "r");
  t.after(() => handle.close());
  const reads = t.mock.method(Object.getPrototypeOf(handle) as typeof handle, "read");
  const later = [];
  for (let result = await batches.next(); !result.done; result = await batches.next()) later.push(...result.value.entries);
  assert.deepEqual(later.map(entry => entry.record), rows.slice(1));
  const bytesRead = (await Promise.all(reads.mock.calls.map(call => call.result))).reduce((n, read) => n + (read?.bytesRead ?? 0), 0);
  assert(bytesRead <= source.fileSize * 3, "one append must not rehash the whole transcript at every subsequent batch");
});

test("a provisional batch must match the seal even if an overlapping rewrite restores the original prefix", async t => {
  const root = await Rollout.create();
  t.after(() => root.close());
  const path = await root.write([Rollout.header("one"), { text: "first" }]);
  const bytes = await readFile(path, "utf8");
  const [source] = await Array.fromAsync(new CodexHistory(root.home).discoverSources());
  const handle = await open(path, "r");
  t.after(() => handle.close());
  const prototype = Object.getPrototypeOf(handle) as typeof handle;
  const read = prototype.read;
  let replaced = false;
  t.mock.method(prototype, "read", async function (this: typeof handle, ...args: Parameters<typeof read>) {
    if (replaced) return Reflect.apply(read, this, args);
    replaced = true;
    await writeFile(path, bytes.replace("first", "wrong") + "\n");
    const result = await Reflect.apply(read, this, args);
    await writeFile(path, bytes + "\n");
    return result;
  });
  await assert.rejects(Array.fromAsync(source.readBatches({ offset: 0, lineNumber: 0 })), { name: "TranscriptChangedError" });
});

test("a growing in-place replacement cannot change the selected header or a captured batch", async t => {
  const root = await Rollout.create();
  t.after(() => root.close());
  const path = await root.write([Rollout.header("one"), { text: "retained" }, { text: "suffix" }]);
  const before = await readFile(path);
  const changed = (part: string, next: string) => before.toString().replace(part, next) + "extra bytes\n";
  const reader = new CodexHistory(root.home);
  const [captured] = await Array.fromAsync(reader.discoverSources({ sessionIds: ["one"] }));
  await writeFile(path, changed('"one"', '"two"'));
  await assert.rejects(Array.fromAsync(captured.readBatches({ offset: 0, lineNumber: 0 })), { name: "TranscriptChangedError" });

  await writeFile(path, before);
  const [again] = await Array.fromAsync(reader.discoverSources());
  const batches = again.readBatches({ offset: 0, lineNumber: 0 }, 1)[Symbol.asyncIterator]();
  const first = await batches.next();
  assert(!first.done);
  await writeFile(path, changed("suffix", "edited"));
  await assert.rejects(batches.next(), { name: "TranscriptChangedError" });

  await writeFile(path, before);
  await assert.rejects(CapturedTranscriptFile.inspect(path, async chunks => {
    for await (const _chunk of chunks) { await writeFile(path, changed('"one"', '"two"')); break; }
  }), { name: "TranscriptChangedError" });
});

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
  const reader = new ClaudeHistory(fixture.home);
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
  const reader = new CodexHistory(fixture.home);
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
