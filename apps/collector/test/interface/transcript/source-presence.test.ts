import assert from "node:assert/strict";
import { appendFile, mkdir, open, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { test } from "node:test";
import { ClaudeHistory, CodexHistory } from "@tracerelic/collector/providers";
import { CapturedTranscriptFile } from "#src/transcript/captured-transcript-file";
import { TranscriptDirectories } from "#src/transcript/transcript-directories";
import { ClaudeProjectFixture as Claude } from "../../fixtures/claude-project-fixture.ts";
import { CodexRolloutFixture as Rollout } from "../../fixtures/codex-rollout-fixture.ts";

test("both Claude sessions share the captured final newline, excluding an unfinished suffix and later appends", async t => {
  const fixture = await Claude.create();
  t.after(() => fixture.close());
  const path = await fixture.write("project", "mixed", [{ sessionId: "a" }, { sessionId: "b" }]);
  await appendFile(path, Buffer.from([0xff, 13, 10]));
  const complete = (await stat(path)).size;
  await appendFile(path, "x".repeat(140 * 1024));
  const reader = new ClaudeHistory(fixture.home);
  const [a, b] = await Array.fromAsync(reader.discoverSources());
  await appendFile(path, "\n");
  assert.equal(await a.completeEnd(), complete);
  const handle = await open(path, "r");
  t.after(() => handle.close());
  const reads = t.mock.method(Object.getPrototypeOf(handle) as typeof handle, "read");
  assert.equal(await b.completeEnd(), complete);
  assert.equal(reads.mock.callCount(), 0);
  await truncate(path, complete);
  await assert.rejects(a.completeEnd(), { name: "TranscriptChangedError", sourceFile: path });
});

test("the captured complete end is zero until the first newline", async t => {
  const fixture = await Claude.create();
  t.after(() => fixture.close());
  const path = await fixture.write("project", "partial", []);
  for (const data of ["", "é".repeat(67584), "\r\n"]) {
    await writeFile(path, data);
    const { file } = await CapturedTranscriptFile.inspect(path, async () => undefined);
    assert.equal(await file.completeEnd(), data.endsWith("\n") ? Buffer.byteLength(data) : 0);
  }
});

test("a sealed transcript already knows its last complete byte", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const path = await fixture.write([Rollout.header("id"), { text: "x".repeat(160 * 1024) }]);
  const [source] = await Array.fromAsync(new CodexHistory(fixture.home).discoverSources());
  const handle = await open(path, "r");
  t.after(() => handle.close());
  const reads = t.mock.method(Object.getPrototypeOf(handle) as typeof handle, "read");
  assert.equal(await source.completeEnd(), source.fileSize);
  assert.equal(reads.mock.callCount(), 0);
});

test("Codex checks active and archived rollout names even when a present file has no readable header", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const path = await fixture.write([{ type: "session_meta", payload: { id: "one", cwd: "/work/one" } }]);
  const reader = new CodexHistory(fixture.home);
  const [source] = await Array.fromAsync(reader.discoverSources({ sessionIds: ["one"] }));
  assert.equal(source.selectionCwd, "/work/one");
  const key = basename(path);
  const absent = "rollout-missing.jsonl";
  assert.deepEqual(await reader.confirmedAbsent([key, absent]), [absent]);
  const archived = join(fixture.home, "archived_sessions", "2026", key);
  await mkdir(dirname(archived), { recursive: true });
  await rename(path, archived);
  await writeFile(archived, "{unfinished");
  assert.deepEqual(await Array.fromAsync(reader.discoverSources()), []);
  assert.deepEqual(await reader.confirmedAbsent([key, absent]), [absent]);
  await rm(archived);
  assert.deepEqual(await reader.confirmedAbsent([key]), [key]);
});

test("a Claude current or subagent transcript can be located under its earlier-copy name", async t => {
  const fixture = await Claude.create();
  t.after(() => fixture.close());
  const reader = new ClaudeHistory(fixture.home);
  const current = await fixture.write("encoded", "chat", []);
  const earlier = join(dirname(current), "chat.orphaned-1700000000000-copy.jsonl");
  await rename(current, earlier);
  const subagent = await fixture.write("encoded", "parent/subagents/agent-reader", []);
  await rename(subagent, subagent + ".superseded-1700000000000");
  const paths = [current, earlier, subagent].map(file => relative(fixture.home, file));
  assert.deepEqual(await reader.confirmedAbsent(paths), []);
  await rm(earlier);
  await fixture.write("different", "chat.orphaned-1700000000000-copy", []);
  assert.deepEqual(await reader.confirmedAbsent(paths), paths.slice(0, 2));
});

test("an unavailable root or failed directory read cannot confirm a missing file", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const unavailable = join(fixture.home, "elsewhere");
  const codex = new CodexHistory(unavailable);
  const claude = new ClaudeHistory(unavailable);
  assert.deepEqual(await codex.confirmedAbsent(["rollout-absent.jsonl"]), []);
  assert.deepEqual(await claude.confirmedAbsent(["projects/p/absent.jsonl"]), []);
  await writeFile(unavailable, "not a directory");
  await assert.rejects(codex.confirmedAbsent(["rollout-absent.jsonl"]), { code: "ENOTDIR" });
  await assert.rejects(claude.confirmedAbsent(["projects/p/absent.jsonl"]), { code: "ENOTDIR" });
});

test("a move from the archive into an already-checked directory cannot confirm absence", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const archived = await fixture.write([Rollout.header("id")], true);
  const active = join(fixture.home, "sessions");
  await mkdir(active);
  const key = basename(archived);
  const missing = await TranscriptDirectories.absent(fixture.home, [key], async function* (list) {
    for (const row of await list(active)) yield row.name;
    await rename(archived, join(active, key));
    for (const row of await list(dirname(archived))) yield row.name;
  });
  assert.deepEqual(missing, []);
});

test("Claude exposes the effective project for ID and directory selections and for an orphaned copy", async t => {
  const fixture = await Claude.create();
  t.after(() => fixture.close());
  const current = await fixture.write("encoded", "chat", [{ sessionId: "id", cwd: "relative" }, { sessionId: "other", cwd: "/other" }]);
  await appendFile(current, '{"sessionId":"id","c\\u0077d":"/work/one"}\n{"sessionId":"id","cwd":"/work/later"}\n');
  const earlier = await fixture.write("encoded", "chat.orphaned-1700000000000-copy", [{ sessionId: "id" }]);
  const reader = new ClaudeHistory(fixture.home);
  for (const selection of [{}, { sessionIds: ["id"] }, { projectPaths: ["/work"] }]) {
    const sources = await Array.fromAsync(reader.discoverSources(selection));
    assert.deepEqual(sources.filter(s => s.sessionId === "id").map(s => [s.sourceFile, s.projectDir, s.selectionCwd]),
      [current, earlier].map(path => [path, dirname(current), "/work/one"]));
  }
});

test("an earlier Claude file retains both working directories regardless of how it was selected", async t => {
  const fixture = await Claude.create();
  t.after(() => fixture.close());
  const current = await fixture.write("project", "chat", [{ sessionId: "s", cwd: "/work/a" }]);
  const previous = await fixture.write("project", "chat.orphaned-123-copy", [{ sessionId: "s", cwd: "/work/b" }]);
  const reader = new ClaudeHistory(fixture.home);
  for (const selection of [{}, { sessionIds: ["s"] }, { projectPaths: ["/work/a"] }, { projectPaths: ["/work/b"] }]) {
    const sources = await Array.fromAsync(reader.discoverSources(selection));
    const directories = sources.map(source => [source.sourceFile, source.selectionCwd, source.currentFileCwd]);
    const earlier = [previous, "/work/b", "/work/a"];
    assert.deepEqual(directories, selection.projectPaths?.includes("/work/b") ? [earlier] : [[current, "/work/a", undefined], earlier]);
  }
});
