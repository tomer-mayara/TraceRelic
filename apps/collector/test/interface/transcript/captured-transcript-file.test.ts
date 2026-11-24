import assert from "node:assert/strict";
import { appendFile, open, stat, truncate, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { ClaudeHistory, CodexHistory } from "@tracerelic/collector/providers";
import { CapturedTranscriptFile } from "#src/transcript/captured-transcript-file";
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
