import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClaudeTranscriptEntry, ClaudeTranscriptSource } from "@tracerelic/collector/providers";
import { ClaudeScan } from "#src/providers/claude/claude-scan";
import { ProviderHistoryStub, ScanPassFixture } from "../../../fixtures/provider-scan-fixture.ts";

const current = "/claude/projects/p/one.jsonl";
const transcript = (sessionId: string, fields: Partial<ClaudeTranscriptSource> = {}): ClaudeTranscriptSource =>
  ({ ...ScanPassFixture.source<ClaudeTranscriptEntry>({ sessionId, sourceFile: current }), previousCopy: false, ...fields });
const earlierCopy = () => transcript("a", { sourceFile: `${current}.superseded-1`, previousCopy: true });
const pass = () => new ClaudeScan(new ProviderHistoryStub<ClaudeTranscriptSource>("/claude"), {});

test("the selected sessions of one Claude file are one group, and two files give two groups", async () => {
  const [first, second] = [transcript("a"), transcript("b")];
  const other = transcript("a", { sourceFile: "/claude/projects/p/two.jsonl" });
  const history = new ProviderHistoryStub("/claude", [[first, second, other]]);
  const selection = { projectPaths: ["/work"] };
  const options = { onChanged: () => {} };
  assert.deepEqual(await Array.fromAsync(new ClaudeScan(history, selection).discoverFiles(options)), [[first, second], [other]]);
  assert.equal(history.calls.length, 1);
  assert.equal(history.calls[0].selection, selection);
  assert.equal(history.calls[0].options, options);
});

test("a Claude source is located by its path under the root, and its root-based stream ID is the file", () => {
  const scan = pass();
  assert.deepEqual(scan.locate(transcript("a")), { location: { root: "/claude", path: "projects/p/one.jsonl" }, rootStreamId: current });
  const located = scan.locate(transcript("a", { selectionCwd: "/work/app", projectDir: "/claude/projects/p", currentFileCwd: "/work/old" }));
  assert.deepEqual(located, { location: { root: "/claude", path: "projects/p/one.jsonl", cwd: "/work/app",
    projectDir: "/claude/projects/p", currentFileCwd: "/work/old" }, rootStreamId: current });
  assert.deepEqual(Object.keys(located.location), ["root", "path", "cwd", "projectDir", "currentFileCwd"]);
});

test("only the format of an earlier Claude copy prepares its batches", () => {
  const scan = pass();
  assert.equal(scan.parserFor(transcript("a")).prepareBatch, undefined);
  assert.equal(typeof scan.parserFor(earlierCopy()).prepareBatch, "function");
});

test("an earlier Claude copy skips an empty first batch without a stored session, and drops a fallback field that storage has", () => {
  const { prepareBatch } = pass().parserFor(earlierCopy());
  assert.ok(prepareBatch);
  assert.equal(prepareBatch({ messages: [], metadata: {} }, null, 0), false);
  const chat = { messages: [], metadata: { cwd: "/copy", repository: "trace", branch: "topic" } };
  assert.equal(prepareBatch(chat, ScanPassFixture.storedSession({ cwd: "/stored" }), 0), true);
  assert.deepEqual(chat.metadata, { repository: "trace", branch: "topic" });
});

test("an earlier Claude copy that continues the current stream is read with the format of a current file", () => {
  const scan = pass();
  const restored = scan.earlierCopies.open(earlierCopy()).format();
  assert.equal(restored.prepareBatch, undefined);
  assert.deepEqual(Object.keys(restored), Object.keys(scan.parserFor(transcript("a"))));
});
