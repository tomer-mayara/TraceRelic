import assert from "node:assert/strict";
import { copyFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { GlobalConfig } from "@tracerelic/collector/config";
import { LocalLLMHistoryClaude, type LocalLLMHistory } from "@tracerelic/collector/history";
import { ClaudeProjectFixture as Claude } from "../../fixtures/claude-project-fixture.ts";

const start = new Date("2026-02-01T00:00:00Z");
const end = new Date("2026-02-02T00:00:00Z");

test("reads the original Claude user string, assistant blocks, and usage within the date window", async t => {
  const fixture = await Claude.create();
  t.after(() => fixture.close());
  const prompt = Claude.user("h1", "2026-01-31T19:00:00.000-05:00", "Plan search");
  const answer = Claude.assistant("h1", "2026-02-01T12:00:00.000Z", "Use an index");
  const sourceFile = await fixture.write("-work-one", "copied-session", [
    Claude.user("h1", "2026-01-31T23:59:59.999Z", "Earlier"), prompt, answer,
    Claude.user("h1", "2026-02-02T00:00:00.000Z", "Next day"),
  ]);
  const lastModified = new Date("2026-03-01T00:00:00Z");
  await utimes(sourceFile, lastModified, lastModified);

  const reader: LocalLLMHistory = new LocalLLMHistoryClaude(new GlobalConfig(join(fixture.home, "codex"), fixture.home));
  assert.deepEqual(await reader.readLocalHistory(start, end), [
    { harness: "claude", sessionId: "h1", sourceFile, lineNumber: 2, timestamp: prompt.timestamp, record: prompt },
    { harness: "claude", sessionId: "h1", sourceFile, lineNumber: 3, timestamp: answer.timestamp, record: answer },
  ]);
});

test("reads both projects and gives a subagent that repeats its parent's ID a distinct session key", async t => {
  const fixture = await Claude.create();
  t.after(() => fixture.close());
  const at = start.toISOString();
  const parent = Claude.user("h1", at, "Plan search");
  const peer = Claude.user("h2", at, "Plan indexing");
  const child = { ...Claude.assistant("h1", at, "Read the plan"), isSidechain: true, agentId: "worker/1" };
  const parentFile = await fixture.write("-work-one", "h1", [parent]);
  const peerFile = await fixture.write("-work-two", "h2", [peer]);
  const childFile = await fixture.write("-work-one", "h1/subagents/agent-worker", [child]);

  const reader: LocalLLMHistory = new LocalLLMHistoryClaude(new GlobalConfig(join(fixture.home, "codex"), fixture.home));
  const entries = await reader.readLocalHistory(start, end);
  assert.deepEqual([...entries].sort((a, b) => a.sessionId.localeCompare(b.sessionId)), [
    { harness: "claude", sessionId: "h1", sourceFile: parentFile, lineNumber: 1, timestamp: at, record: parent },
    { harness: "claude", sessionId: "h1/subagents/worker%2F1", sourceFile: childFile, lineNumber: 1, timestamp: at, record: child },
    { harness: "claude", sessionId: "h2", sourceFile: peerFile, lineNumber: 1, timestamp: at, record: peer },
  ]);
});

test("reads a subagent without its parent file and keeps independent native session IDs", async t => {
  const fixture = await Claude.create();
  t.after(() => fixture.close());
  const at = start.toISOString();
  const repeated = Claude.user("parent%1", at, "Read the plan");
  const independent = Claude.assistant("child-7", at, "Plan is ready");
  const sourceFile = await fixture.write("-work-one", "parent%1/subagents/agent-helper", [
    { type: "progress", timestamp: at }, repeated, independent,
  ]);

  const reader: LocalLLMHistory = new LocalLLMHistoryClaude(new GlobalConfig(join(fixture.home, "codex"), fixture.home));
  assert.deepEqual(await reader.readLocalHistory(start, end), [
    { harness: "claude", sessionId: "parent%251/subagents/helper", sourceFile, lineNumber: 2, timestamp: at, record: repeated },
    { harness: "claude", sessionId: "child-7", sourceFile, lineNumber: 3, timestamp: at, record: independent },
  ]);
});

test("skips prompt history, tool-result files, and unrelated files inside the subagents directory", async t => {
  const fixture = await Claude.create();
  t.after(() => fixture.close());
  const rows = [Claude.user("h1", start.toISOString(), "Unselected source")];
  const toolFile = await fixture.write("-work-one", "h1/tool-results/agent-worker", rows);
  await copyFile(toolFile, join(fixture.home, "history.jsonl"));
  await fixture.write("-work-one", "h1/subagents/other", rows);
  await fixture.write("-work-one", "h1/subagents/archive/agent-worker", rows);

  const reader: LocalLLMHistory = new LocalLLMHistoryClaude(new GlobalConfig(join(fixture.home, "codex"), fixture.home));
  assert.deepEqual(await reader.readLocalHistory(start, end), []);
});
