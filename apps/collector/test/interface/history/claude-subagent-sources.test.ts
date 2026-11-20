import assert from "node:assert/strict";
import { test } from "node:test";
import { GlobalConfig } from "@tracerelic/collector/config";
import { LocalLLMHistoryClaude } from "@tracerelic/collector/history";
import { ClaudeProjectFixture } from "../../fixtures/claude-project-fixture.ts";

test("a shared Claude subagent file exposes the selected native agents and keeps other sessions independent", async t => {
  const fixture = await ClaudeProjectFixture.create();
  t.after(() => fixture.close());
  await fixture.write("project", "parent/subagents/agent-worker", [
    { sessionId: "parent", agentId: "a/1" }, { sessionId: "parent", agentId: "b" },
    { sessionId: "parent" }, { sessionId: "neighbor" }, { sessionId: "native-child", agentId: "worker", isSidechain: true },
  ]);
  const reader = new LocalLLMHistoryClaude(new GlobalConfig(fixture.home, fixture.home));
  const all = await Array.fromAsync(reader.discoverSources());
  const agents = all.map(({ sessionId, claudeSubagent }) => [sessionId, claudeSubagent]);
  assert.deepEqual(agents, [
    ["parent/subagents/a%2F1", { parentSessionId: "parent", agentId: "a/1" }],
    ["parent/subagents/b", { parentSessionId: "parent", agentId: "b" }],
    ["parent/subagents/worker", { parentSessionId: "parent", agentId: "worker" }],
    ["neighbor", undefined], ["native-child", { parentSessionId: "parent", agentId: "worker" }],
  ]);
  const selected = await Array.fromAsync(reader.discoverSources({ sessionIds: ["parent/subagents/b"] }));
  assert.deepEqual(selected.map(source => source.claudeSubagent), [{ parentSessionId: "parent", agentId: "b" }]);
  const [batch] = await Array.fromAsync(selected[0].readBatches({ offset: 0, lineNumber: 0 }));
  assert.deepEqual(batch.entries.map(entry => entry.record.agentId), ["b"]);
});

test("an ID-only selection finds a native child's agent identity after rows copied without an agent ID", async t => {
  const fixture = await ClaudeProjectFixture.create();
  t.after(() => fixture.close());
  await fixture.write("project", "parent/subagents/agent-worker", [
    { sessionId: "child", isSidechain: false }, { sessionId: "child", isSidechain: true, agentId: "worker" },
  ]);
  const reader = new LocalLLMHistoryClaude(new GlobalConfig(fixture.home, fixture.home));
  const [child] = await Array.fromAsync(reader.discoverSources({ sessionIds: ["child"] }));
  assert.deepEqual(child.claudeSubagent, { parentSessionId: "parent", agentId: "worker" });
});
