import assert from "node:assert/strict";
import { appendFile, copyFile, stat } from "node:fs/promises";
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
    return transcripts.map(transcript => transcript.sessionId).sort();
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
