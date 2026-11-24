import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, copyFile, readFile, rename, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CodexHistory, type CodexSelection } from "@tracerelic/collector/providers";
import { CodexRolloutFixture as Rollout } from "../../../fixtures/codex-rollout-fixture.ts";
import { type CodexRollout, TranscriptSnapshots } from "../../../fixtures/transcript-snapshots.ts";

test("a discovered Codex source has no previousCopy, and only its response_item and event_msg records get the digest through their own line", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const at = "2026-02-01T08:00:00Z";
  const rows = [Rollout.header("one"), Rollout.message(at, "Plan"), Rollout.tokenCount(at), Rollout.turnContext(at, "t1"),
    { timestamp: at, type: "user", message: { role: "user", content: "Plan" } }];
  const sourceFile = await fixture.write(rows);
  const bytes = await readFile(sourceFile);
  const [source] = await Array.fromAsync(new CodexHistory(fixture.home).discoverSources());
  assert.equal("previousCopy" in source, false);
  const entries = (await Array.fromAsync(source.readBatches({ offset: 0, lineNumber: 0 }))).flatMap(batch => batch.entries);
  const digest = (offset: number) => createHash("sha256").update(bytes.subarray(0, offset)).digest("hex");
  assert.deepEqual(entries.map(entry => [entry.record.type, entry.recordPrefixDigest]), [
    ["session_meta", undefined], ["response_item", digest(entries[1].endOffset)], ["event_msg", digest(entries[2].endOffset)],
    ["turn_context", undefined], ["user", undefined],
  ]);
});

test("selects Codex rollouts by their first native header within the configured workspace root", async t => {
  const configured = await Rollout.create();
  t.after(() => configured.close());
  const elsewhere = await Rollout.create();
  t.after(() => elsewhere.close());
  t.mock.property(process, "env", { ...process.env, CODEX_HOME: elsewhere.home, CODEX_PATH: elsewhere.home });

  const project = "/work/search";
  const active = await configured.write([
    Rollout.header(""),
    { type: "session_meta", payload: { id: "active", cwd: project + "/frontend" } },
    { type: "session_meta", payload: { id: "copied", cwd: "/other" } },
  ]);
  await configured.write([{ type: "session_meta", payload: { session_id: "archived", cwd: project + "-old" } }], true);
  const outside = await elsewhere.write([Rollout.header("outside")]);
  await copyFile(outside, join(configured.home, "rollout-ignored.jsonl"));
  await symlink(dirname(outside), join(dirname(active), "other-directory"), "dir");

  const reader = new CodexHistory(configured.home);
  const sessionIds = async (selection?: CodexSelection) => {
    const ids: string[] = [];
    for await (const rollout of TranscriptSnapshots.rollouts(reader, selection)) ids.push(rollout.sessionId);
    const sources = await Array.fromAsync(reader.discoverSources(selection));
    assert.deepEqual(sources.map(source => source.sessionId).sort(), ids.sort());
    return ids;
  };
  assert.deepEqual(await sessionIds(), ["active", "archived"]);
  assert.deepEqual(await sessionIds({ sessionIds: [], projectPaths: [] }), ["active", "archived"]);
  assert.deepEqual(await sessionIds({ sessionIds: ["archived"] }), ["archived"]);
  assert.deepEqual(await sessionIds({ projectPaths: [project] }), ["active"]);
  assert.deepEqual(await sessionIds({ projectPaths: [project + "-old"] }), ["archived"]);
  assert.deepEqual(await sessionIds({ sessionIds: ["archived"], projectPaths: [project] }), ["active", "archived"]);
  assert.deepEqual(await sessionIds({ sessionIds: ["outside", "copied"], projectPaths: ["/other"] }), []);
});

test("discovers fork identity and creation time only from the child's own native header", async t => {
  const root = await Rollout.create();
  t.after(() => root.close());
  const forkedAt = "2026-02-01T02:00:00.128Z";
  const child = Rollout.header("child");
  const copied = { ...Rollout.header("parent"), payload: { id: "parent", forked_from_id: "grandparent" } };
  const reader = new CodexHistory(root.home);
  for (const link of [
    { forked_from_id: "parent" },
    { forked_from: "parent" },
    { source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } } },
  ]) {
    await root.write([{ ...child, payload: { ...child.payload, session_id: "root", timestamp: forkedAt, ...link } }, copied]);
    const [source] = await Array.fromAsync(reader.discoverSources());
    assert.equal(source.sessionId, "child");
    assert.deepEqual(source.codexForkHeader, { parentSessionId: "parent", forkedAt });
  }
  await root.write([child, copied]);
  const [ordinary] = await Array.fromAsync(reader.discoverSources());
  assert.equal(ordinary.codexForkHeader, undefined);
});

test("reads Codex batches from the specified byte and physical line, with a large UTF-8 record alone", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const header = Rollout.header("one");
  const sourceFile = await fixture.write([{ note: "before the native header" }, header]);
  const start = { offset: (await stat(sourceFile)).size, lineNumber: 2 };
  const first = JSON.stringify({ text: "é" }) + "\r\n";
  const second = JSON.stringify({ text: "🌱" }) + "\n";
  const budget = Buffer.byteLength(first + second);
  const prefix = Buffer.byteLength(first + second + '{"text":"');
  // The four-byte character straddles a 64 KiB read boundary after the seek.
  const largeText = "x".repeat(64 * 1024 - 1 - prefix) + "🌱" + "y".repeat(200 * 1024);
  const large = JSON.stringify({ text: largeText }) + "\n";
  const final = JSON.stringify({ text: "done" }) + "\n";
  await appendFile(sourceFile, first + second + large + final);

  const reader = new CodexHistory(fixture.home);
  const [source] = await Array.fromAsync(reader.discoverSources());
  const { readBatches: _readBatches, prefixDigests: _prefixDigests, completeEnd: _completeEnd, ...info } = source;
  assert.deepEqual(info, { sourceFile, sessionId: "one", fileSize: (await stat(sourceFile)).size, codexHeaderEnd: start.offset });
  const throughPair = { offset: start.offset + budget, lineNumber: 4 };
  const throughLarge = { offset: throughPair.offset + Buffer.byteLength(large), lineNumber: 5 };
  const throughFinal = { offset: throughLarge.offset + Buffer.byteLength(final), lineNumber: 6 };

  for (const maxBytes of [undefined, budget]) {
    const batches = await Array.fromAsync(source.readBatches(start, maxBytes));
    assert.deepEqual(batches.map(batch => batch.next), [throughPair, throughLarge, throughFinal]);
    assert.deepEqual(batches.map(batch => batch.entries.map(entry => entry.lineNumber)), [[3, 4], [5], [6]]);
    assert.deepEqual(batches[1].entries[0].record, { text: largeText });
  }
  const shortBatches = await Array.fromAsync(source.readBatches(start, budget - 1, throughPair.offset));
  assert.deepEqual(shortBatches.map(batch => batch.next), [
    { offset: start.offset + Buffer.byteLength(first), lineNumber: 3 }, throughPair,
  ]);
  const prefixBatches = await Array.fromAsync(source.readBatches({ offset: 0, lineNumber: 0 }, undefined, start.offset));
  assert.deepEqual(prefixBatches.flatMap(batch => batch.entries.map(entry => entry.record)), [header]);
});

test("marks the native header after a verified blank prefix across batches and resumed reads", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const native = Rollout.header("native");
  const copied = Rollout.header("copied");
  const path = await fixture.write([native, copied]);
  const body = [native, copied].map(record => JSON.stringify(record) + "\n").join("");
  const reader = new CodexHistory(fixture.home);
  for (const [prefix, expected] of [
    [" \r\n\t\n", true], ["", undefined], ["\nnull\n", undefined],
    ["broken JSON\n\n", undefined], ["{}\n", undefined], ["\u00a0\n", undefined],
  ] as const) {
    await writeFile(path, prefix + body);
    const [source] = await Array.fromAsync(reader.discoverSources());
    const offset = Buffer.byteLength(prefix);
    const lineNumber = prefix.split("\n").length - 1;
    for (const start of [{ offset: 0, lineNumber: 0 }, { offset, lineNumber }]) {
      const batches = await Array.fromAsync(source.readBatches(start, 1));
      const entries = batches.flatMap(batch => batch.entries);
      assert.deepEqual(entries.map(entry => entry.afterBlankPrefix), [expected, undefined]);
      assert.equal(entries[0].lineNumber, lineNumber + 1);
      assert.equal(entries[0].startOffset, offset);
    }
    const [rollout] = await Array.fromAsync(TranscriptSnapshots.rollouts(reader));
    assert(rollout.entries.every(entry => !("afterBlankPrefix" in entry)));
  }
});

test("rejects an equally long replacement between discovery and the batch read", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const sourceFile = await fixture.write([Rollout.header("original")]);
  const reader = new CodexHistory(fixture.home);
  const [source] = await Array.fromAsync(reader.discoverSources());
  await rename(sourceFile, sourceFile + ".old");
  await fixture.write([Rollout.header("replaced")]);
  assert.equal((await stat(sourceFile)).size, source.fileSize);
  await assert.rejects(Array.fromAsync(source.readBatches({ offset: 0, lineNumber: 0 })), {
    name: "TranscriptChangedError", sourceFile,
  });
});

test("reports only the raw byte ranges of damaged complete records across batch limits", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const file = await fixture.write([Rollout.header("damaged")]);
  const start = { offset: (await stat(file)).size, lineNumber: 1 };
  const physical = [
    Buffer.from(" \t\r\n"),
    Buffer.from('{"text":"é"},\r\n'),
    Buffer.from("null\n"),
    Buffer.concat([Buffer.from('{"private":"'), Buffer.alloc(80 * 1024, 0x78), Buffer.from([0xc0, 0x80]), Buffer.from('"}\r\n')]),
    Buffer.from(JSON.stringify({ text: "Continue" }) + "\n"),
  ];
  await appendFile(file, Buffer.concat([...physical, Buffer.from('{"pending":')]));
  const ends = [start.offset];
  for (const line of physical) ends.push(ends[ends.length - 1] + line.length);
  const reader = new CodexHistory(fixture.home);
  const [source] = await Array.fromAsync(reader.discoverSources());

  for (const budget of [1, 8192, source.fileSize]) {
    const batches = await Array.fromAsync(source.readBatches(start, budget));
    assert.deepEqual(batches.flatMap(batch => batch.damagedLines ?? []), [
      { lineNumber: 3, startOffset: ends[1], endOffset: ends[2] },
      { lineNumber: 4, startOffset: ends[2], endOffset: ends[3] },
      { lineNumber: 5, startOffset: ends[3], endOffset: ends[4] },
    ]);
    const [last] = batches.flatMap(batch => batch.entries);
    assert.deepEqual([last.startOffset, last.endOffset, last.record], [ends[4], ends[5], { text: "Continue" }]);
    assert.deepEqual(batches.at(-1)?.next, { offset: ends[5], lineNumber: 6 });
  }
  const resumed = await Array.fromAsync(source.readBatches({ offset: ends[4], lineNumber: 5 }));
  assert.equal(resumed.length, 1);
  assert(!("damagedLines" in resumed[0]));
});

test("discards a pending batch when a captured file shrinks between reads", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const sourceFile = await fixture.write([Rollout.header("chat"), { text: "pending" }]);
  const reader = new CodexHistory(fixture.home);
  const [source] = await Array.fromAsync(reader.discoverSources());
  const batches = source.readBatches({ offset: 0, lineNumber: 0 }, 1)[Symbol.asyncIterator]();
  const first = await batches.next();
  assert(!first.done);
  try {
    await truncate(sourceFile, first.value.next.offset);
    await assert.rejects(batches.next(), { name: "TranscriptChangedError", sourceFile });
  } finally {
    await batches.return?.();
  }
});

test("returns undated Codex metadata and the byte position after the last decoded record", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const header = { type: "session_meta", payload: { id: "c1" } };
  const context = { type: "turn_context", payload: { turn_id: "t1", cwd: "/work/here" } };
  const message = Rollout.message("2026-02-01T08:00:00Z", "Plan 🌱");
  const sourceFile = await fixture.write([header]);
  const headerEnd = (await stat(sourceFile)).size;
  const throughContext = "broken\n" + JSON.stringify(context) + "\r\n";
  await appendFile(sourceFile, throughContext + JSON.stringify(message) + "\r\n");
  const { size } = await stat(sourceFile);
  await appendFile(sourceFile, "null\n" + JSON.stringify(Rollout.message(message.timestamp, "Unfinished")));

  const reader = new CodexHistory(fixture.home);
  const rollouts: CodexRollout[] = [];
  for await (const rollout of TranscriptSnapshots.rollouts(reader)) rollouts.push(rollout);
  assert.equal(rollouts.length, 1);
  const [rollout] = rollouts;
  assert.equal(rollout.sessionId, "c1");
  assert.equal(rollout.sourceFile, sourceFile);
  assert.equal(rollout.endOffset, size);
  assert.deepEqual(rollout.entries.map(entry => entry.endOffset), [headerEnd, headerEnd + Buffer.byteLength(throughContext), size]);
  assert.deepEqual(rollout.entries.map(entry => [entry.harness, entry.sessionId, entry.sourceFile, entry.lineNumber, entry.timestamp, entry.record]), [
    ["codex", "c1", sourceFile, 1, undefined, header],
    ["codex", "c1", sourceFile, 3, undefined, context],
    ["codex", "c1", sourceFile, 4, message.timestamp, message],
  ]);
});
