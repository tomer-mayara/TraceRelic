import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, copyFile, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { GlobalConfig } from "@tracerelic/collector/config";
import { LocalLLMHistoryClaude, type ScanSelection } from "@tracerelic/collector/history";
import { ClaudeProjectFixture as Claude } from "../../fixtures/claude-project-fixture.ts";

test("selects Claude sessions by ID, first recorded working directory, or exact transcript project directory", async t => {
  const fixture = await Claude.create();
  t.after(() => fixture.close());
  const file = await fixture.write("encoded", "different-filename", [
    { sessionId: "one" }, { sessionId: "two", cwd: "/work/plan-old" },
    { sessionId: "one", cwd: "/work/plan/src" }, { sessionId: "one", cwd: "/later" },
  ]);
  await fixture.write("encoded-old", "peer", [{ sessionId: "three" }]);
  const unrelated = await fixture.write("encoded", "one/tool-results/agent-reader", [{ sessionId: "tool" }]);
  await copyFile(unrelated, join(fixture.home, "history.jsonl"));
  await fixture.write("encoded", "one/subagents/other", [{ sessionId: "unrelated" }]);
  const reader = new LocalLLMHistoryClaude(new GlobalConfig("/codex", fixture.home));
  const ids = async (selection?: ScanSelection) => {
    const transcripts = await Array.fromAsync(reader.readTranscripts(selection));
    const expected = transcripts.map(transcript => transcript.sessionId).sort();
    const sources = await Array.fromAsync(reader.discoverSources(selection));
    assert.deepEqual(sources.map(source => source.sessionId).sort(), expected);
    return expected;
  };
  assert.deepEqual(await ids(), ["one", "three", "two"]);
  assert.deepEqual(await ids({ sessionIds: [], projectPaths: [] }), ["one", "three", "two"]);
  assert.deepEqual(await ids({ sessionIds: ["two"] }), ["two"]);
  assert.deepEqual(await ids({ sessionIds: ["three"], projectPaths: ["/work/plan"] }), ["one", "three"]);
  assert.deepEqual(await ids({ projectPaths: ["/later", dirname(dirname(file))], sessionIds: ["different-filename"] }), []);
  assert.deepEqual(await ids({ projectPaths: [dirname(file)] }), ["one", "two"]);
  const [selected] = await Array.fromAsync(reader.readTranscripts({ projectPaths: ["/work/plan"] }));
  assert.deepEqual(selected.entries.map(entry => entry.lineNumber), [1, 3, 4]);
  const disabled = new LocalLLMHistoryClaude(new GlobalConfig(fixture.home));
  assert.deepEqual(await Array.fromAsync(disabled.readTranscripts()), []);
  assert.deepEqual(await Array.fromAsync(disabled.discoverSources()), []);
});

test("returns complete Claude records grouped by effective session with byte offsets and original line numbers", async t => {
  const fixture = await Claude.create();
  t.after(() => fixture.close());
  const childId = "parent/subagents/helper";
  const child = Claude.user("parent", "2026-02-01T12:00:00Z", "Café");
  const other = Claude.user("independent", "invalid", "Other session");
  const metadata = { sessionId: "parent", type: "progress" };
  const sourceFile = await fixture.write("project", "parent/subagents/agent-helper", [child]);
  const childEnd = (await stat(sourceFile)).size;
  await appendFile(sourceFile, "broken\n" + JSON.stringify(other) + "\r\n");
  const otherEnd = (await stat(sourceFile)).size;
  await appendFile(sourceFile, JSON.stringify(metadata) + "\n");
  const metadataEnd = (await stat(sourceFile)).size;
  await appendFile(sourceFile, JSON.stringify(child));
  const reader = new LocalLLMHistoryClaude(new GlobalConfig("/codex", fixture.home));
  const [childTranscript, otherTranscript] = await Array.fromAsync(reader.readTranscripts());
  const shared = { sourceFile, harness: "claude" };
  assert.deepEqual(childTranscript, { sessionId: childId, sourceFile, previousCopy: false, endOffset: metadataEnd, entries: [
    { ...shared, sessionId: childId, record: child, timestamp: child.timestamp, lineNumber: 1, endOffset: childEnd },
    { ...shared, sessionId: childId, record: metadata, lineNumber: 4, endOffset: metadataEnd },
  ] });
  assert.deepEqual(otherTranscript, { sessionId: "independent", sourceFile, previousCopy: false, endOffset: otherEnd, entries: [
    { ...shared, sessionId: "independent", record: other, lineNumber: 3, endOffset: otherEnd },
  ] });
  assert.deepEqual(await Array.fromAsync(reader.readTranscripts({ sessionIds: [childId] })), [childTranscript]);
  assert.deepEqual(await Array.fromAsync(reader.readTranscripts({ sessionIds: ["parent"] })), []);
  const sources = await Array.fromAsync(reader.discoverSources());
  assert.deepEqual(sources.map(source => source.sessionId), [childId, "independent"]);
  const afterBroken = childEnd + Buffer.byteLength("broken\n");
  const bytes = await readFile(sourceFile);
  for (const [i, transcript] of [childTranscript, otherTranscript].entries()) {
    const batches = await Array.fromAsync(sources[i].readBatches({ offset: 0, lineNumber: 0 }));
    assert.deepEqual(batches.flatMap(batch => batch.damagedLines ?? []),
      [{ lineNumber: 2, startOffset: childEnd, endOffset: afterBroken }]);
    const starts = i === 0 ? [0, otherEnd] : [afterBroken];
    assert.deepEqual(batches.flatMap(batch => batch.entries), transcript.entries.map((entry, j) =>
      ({ ...entry, startOffset: starts[j], ...(entry.record.type === "user"
        && { recordPrefixDigest: createHash("sha256").update(bytes.subarray(0, entry.endOffset)).digest("hex") }) })));
    assert.deepEqual(batches.at(-1)?.next, { offset: metadataEnd, lineNumber: 4 });
  }
});

test("reads current Claude sources before orphaned and superseded copies", async t => {
  const fixture = await Claude.create();
  t.after(() => fixture.close());
  const rows = [{ sessionId: "native", uuid: "row-1" }];
  const orphan = await fixture.write("a-project", "session.orphaned-1760000000000-copy", rows);
  const current = await fixture.write("z-project", "session", rows);
  const superseded = current + ".superseded-1760000000000";
  await copyFile(current, superseded);
  const reader = new LocalLLMHistoryClaude(new GlobalConfig("/codex", fixture.home));
  const transcripts = await Array.fromAsync(reader.readTranscripts());
  assert.deepEqual(transcripts.map(source => source.sessionId), ["native", "native", "native"]);
  assert.deepEqual(transcripts[0].sourceFile, current);
  assert.equal(transcripts[0].previousCopy, false);
  assert.deepEqual(transcripts.slice(1).map(source => [source.sourceFile, source.previousCopy]).sort(),
    [[orphan, true], [superseded, true]].sort());
});

test("includes prior Claude copies only for their own selected file and session or a matching recorded directory", async t => {
  const fixture = await Claude.create();
  t.after(() => fixture.close());
  const sessionId = "shared-id";
  const current = await fixture.write("encoded", "chat", [{ sessionId, cwd: "/work/selected" }]);
  const orphan = await fixture.write("encoded", "chat.orphaned-1700000000000-copy", [
    { sessionId, cwd: "/work/old" }, { sessionId: "different-session" },
  ]);
  const superseded = current + ".superseded-1700000000000";
  await appendFile(superseded, JSON.stringify({ sessionId }) + "\n");
  await fixture.write("encoded", "different.orphaned-1700000000000-copy", [{ sessionId }]);
  await fixture.write("another", "chat.orphaned-1700000000000-copy", [{ sessionId }]);
  const separate = await fixture.write("another", "prior-only.orphaned-1700000000000-copy", [
    { sessionId, cwd: "/work/selected" },
  ]);
  const reader = new LocalLLMHistoryClaude(new GlobalConfig("/codex", fixture.home));
  const sources = await Array.fromAsync(reader.readTranscripts({ projectPaths: ["/work/selected"] }));
  assert.deepEqual(sources.map(source => [source.sourceFile, source.sessionId]).sort(),
    [current, orphan, superseded, separate].map(path => [path, sessionId]).sort());
  const discovered = await Array.fromAsync(reader.discoverSources({ projectPaths: ["/work/selected"] }));
  assert.deepEqual(discovered.map(source => [source.sourceFile, source.sessionId, source.previousCopy]),
    sources.map(source => [source.sourceFile, source.sessionId, source.previousCopy]));
});

test("captures the discovered file size and resumes Claude after malformed lines and a split UTF-8 character", async t => {
  const fixture = await Claude.create();
  t.after(() => fixture.close());
  const first = Claude.user("native", "2026-02-01T12:00:00Z", "Before");
  const final = Claude.user("native", "2026-02-01T13:00:00Z", "café");
  const sourceFile = await fixture.write("project", "transcript", [first]);
  const afterFirst = { offset: (await stat(sourceFile)).size, lineNumber: 1 };
  const broken = Buffer.from(JSON.stringify(final) + "\r\n");
  broken[broken.indexOf("é")] = 0xff;
  const afterBroken = { offset: afterFirst.offset + broken.length, lineNumber: 2 };
  const suffix = Buffer.from(JSON.stringify(final) + "\r\n");
  const split = suffix.indexOf("é") + 1;
  await appendFile(sourceFile, Buffer.concat([broken, suffix.subarray(0, split)]));

  const reader = new LocalLLMHistoryClaude(new GlobalConfig("/codex", fixture.home));
  const [original] = await Array.fromAsync(reader.discoverSources());
  assert.equal(original.fileSize, afterBroken.offset + split);
  await appendFile(sourceFile, suffix.subarray(split));
  const initial = await Array.fromAsync(original.readBatches({ offset: 0, lineNumber: 0 }, undefined, Number.MAX_SAFE_INTEGER));
  assert.deepEqual(initial.flatMap(batch => batch.entries.map(entry => entry.record)), [first]);
  assert.deepEqual(initial.flatMap(batch => batch.damagedLines ?? []),
    [{ lineNumber: 2, startOffset: afterFirst.offset, endOffset: afterBroken.offset }]);
  assert.deepEqual(initial.at(-1)?.next, afterBroken);

  const [updated] = await Array.fromAsync(reader.discoverSources());
  const finalPosition = { offset: afterBroken.offset + suffix.length, lineNumber: 3 };
  assert.equal(updated.fileSize, finalPosition.offset);
  const digest = createHash("sha256").update(JSON.stringify(first) + "\n").update(broken).update(suffix).digest("hex");
  assert.deepEqual(await Array.fromAsync(updated.readBatches(afterBroken, undefined, finalPosition.offset - 1)), []);
  assert.deepEqual(await Array.fromAsync(updated.readBatches(afterBroken)), [{
    entries: [{
      harness: "claude", sessionId: "native", sourceFile, record: final, timestamp: final.timestamp,
      lineNumber: 3, startOffset: afterBroken.offset, endOffset: finalPosition.offset, recordPrefixDigest: digest,
    }],
    next: finalPosition,
    prefixDigest: digest,
  }]);
  assert.deepEqual(await Array.fromAsync(updated.readBatches(finalPosition)), []);
});

test("stops ID-only discovery once all IDs are present and decodes only the requested suffix", async t => {
  const fixture = await Claude.create();
  t.after(() => fixture.close());
  const sourceFile = await fixture.write("project", "mixed", [
    { sessionId: "one" }, { sessionId: "other" }, { sessionId: "two" },
    { sessionId: "two", text: "already accepted text" },
  ]);
  const position = { offset: (await stat(sourceFile)).size, lineNumber: 4 };
  const tail = { sessionId: "two", text: "next text" };
  await appendFile(sourceFile, JSON.stringify(tail) + "\n");
  const reader = new LocalLLMHistoryClaude(new GlobalConfig("/codex", fixture.home));
  const parsed = t.mock.method(JSON, "parse");
  const sources = await Array.fromAsync(reader.discoverSources({ sessionIds: ["two", "one", "one"] }));
  assert.deepEqual(sources.map(source => source.sessionId), ["one", "two"]);
  const resumed = await Array.fromAsync(sources[1].readBatches(position));
  assert.deepEqual(resumed.flatMap(batch => batch.entries.map(entry => entry.record)), [tail]);
  assert(!parsed.mock.calls.some(call => call.arguments[0].includes("already accepted text")));
});

test("uses the first absolute Claude working directory without a NUL character", async t => {
  const fixture = await Claude.create();
  t.after(() => fixture.close());
  await fixture.write("encoded", "chat", [
    { sessionId: "relative", cwd: "subproject" }, { sessionId: "nul", cwd: "/work/rejected/\0" },
    { sessionId: "relative", cwd: "/work/actual" }, { sessionId: "nul", cwd: "/work/actual" },
  ]);
  const reader = new LocalLLMHistoryClaude(new GlobalConfig("/codex", fixture.home));
  assert.deepEqual(await Array.fromAsync(reader.readTranscripts({ projectPaths: [".", "/work/rejected"] })), []);
  const selected = await Array.fromAsync(reader.readTranscripts({ projectPaths: ["/work/actual"] }));
  assert.deepEqual(selected.map(source => source.sessionId).sort(), ["nul", "relative"]);
});
