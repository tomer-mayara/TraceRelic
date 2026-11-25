import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeSessionIdentity } from "#src/providers/claude/claude-session-identity";

const directory = { parentSessionId: "parent", agentId: "worker" };

test("a record whose session ID is empty or not text has no session key", () => {
  for (const sessionId of [undefined, "", 42]) {
    assert.equal(ClaudeSessionIdentity.parse({ type: "user", sessionId }), undefined);
    assert.equal(ClaudeSessionIdentity.parse({ type: "user", sessionId }, directory), undefined);
  }
  assert.deepEqual(ClaudeSessionIdentity.parse({ type: "user", sessionId: "native" }), { sessionId: "native" });
});

test("a subagent record whose agent ID is empty or not text takes the agent ID of its directory", () => {
  for (const agentId of [undefined, "", 42]) {
    assert.deepEqual(ClaudeSessionIdentity.parse({ sessionId: "parent", agentId }, directory),
      { sessionId: "parent/subagents/worker", subagent: directory });
  }
  assert.deepEqual(ClaudeSessionIdentity.parse({ sessionId: "parent", agentId: "a/1" }, directory),
    { sessionId: "parent/subagents/a%2F1", subagent: { parentSessionId: "parent", agentId: "a/1" } });
});
