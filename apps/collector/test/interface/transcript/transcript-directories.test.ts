import assert from "node:assert/strict";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { test } from "node:test";
import { ClaudeHistory, CodexHistory } from "@tracerelic/collector/providers";
import { TranscriptDirectories } from "#src/transcript/transcript-directories";
import { ClaudeProjectFixture as Claude } from "../../fixtures/claude-project-fixture.ts";
import { CodexRolloutFixture as Rollout } from "../../fixtures/codex-rollout-fixture.ts";

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
