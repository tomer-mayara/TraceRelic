import assert from "node:assert/strict";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { CollectorCommand } from "@tracerelic/collector/command";
import { ClaudeProjectFixture as Claude } from "../../fixtures/claude-project-fixture.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";
import { LocalCollectorCliFixture } from "../../fixtures/local-collector-cli-fixture.ts";

test("a mixed scan keeps both provider sessions and recovers identified text from earlier Claude copies once", async t => {
  const fixture = await LocalCollectorCliFixture.create();
  t.after(() => fixture.close());
  const config = await fixture.writeConfig("..", "../claude");
  const sessionId = "shared";
  const args = ["scan", "--once", "--config", config, "--session", sessionId];
  await fixture.writeChat(fixture.configured, sessionId);
  const claude = new Claude(join(fixture.configured.home, "claude"));
  const project = "-work-search";
  const at = "2026-02-01T12:00:00Z";
  const prompt = { ...Claude.user(sessionId, at, "Why?"), uuid: "prompt", cwd: "/work/search" };
  const reply = {
    ...Claude.assistant(sessionId, "2026-02-01T12:01:00Z", "For relevance."),
    uuid: "reply", cwd: "/work/search/frontend", gitBranch: "topic",
  };
  await claude.write(project, sessionId, [prompt, reply]);
  const old = {
    ...Claude.user(sessionId, "2026-01-31T12:00:00Z", "Earlier question"),
    uuid: "earlier", cwd: "/work/old", gitBranch: "main",
  };
  await claude.write(project, sessionId + ".orphaned-1700000000000-a1b2", [
    old, Claude.user(sessionId, at, "Unidentified copy"), prompt,
  ]);
  const extra = { ...old, uuid: "extra", message: { role: "user", content: "Earlier detail" } };
  const superseded = await claude.write(project, "temporary", [old, extra]);
  await rename(superseded, join(claude.home, "projects", project, sessionId + ".jsonl.superseded-1700000000001"));
  await claude.write(project, "other-session", [Claude.user("other-session", at, "Unselected")]);

  const storage = new InMemoryCollectorStorage();
  const scanned = await new CollectorCommand(storage).run(args);
  const codexKey = { harness: "codex", sessionId } as const;
  const claudeKey = { harness: "claude", sessionId } as const;
  const codexChat = await storage.readSession(codexKey);
  const claudeChat = await storage.readSession(claudeKey);
  assert(codexChat);
  assert(claudeChat, "a mixed scan must store the Claude session with the same native ID");
  assert.equal(scanned.length, 2);
  assert.deepEqual(codexChat.messages.map(message => message.text), [sessionId]);
  assert.deepEqual(claudeChat.messages.map(message => message.text).sort(),
    ["Why?", "For relevance.", "Earlier question", "Earlier detail"].sort());
  assert.deepEqual(claudeChat.messages.slice(0, 2).map(({ text, sourceOrder }) => [text, sourceOrder]),
    [["Why?", 1], ["For relevance.", 2]]);
  assert.deepEqual(claudeChat.metadata, { cwd: reply.cwd, branch: reply.gitBranch });
  assert.equal(claudeChat.observedTotalTokens, 72);
  assert.equal(claudeChat.coverage, "reported");
  assert.equal(await storage.readSession({ harness: "claude", sessionId: "other-session" }), null);
  assert.deepEqual(await new CollectorCommand(storage).run(args), scanned);
  const cli = fixture.run(args);
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), scanned);
});

test("an earlier Claude copy creates a session when it supplies identifiable records", async t => {
  const fixture = await LocalCollectorCliFixture.create();
  t.after(() => fixture.close());
  const config = await fixture.writeConfig("..", "../claude");
  const claude = new Claude(join(fixture.configured.home, "claude"));
  const at = "2026-02-01T12:00:00Z";
  await claude.write("project", "saved.orphaned-1700000000000-a", [
    { ...Claude.user("saved", at, "Recovered prompt"), uuid: "original" },
  ]);
  await claude.write("project", "anonymous.orphaned-1700000000000-b", [
    Claude.user("anonymous", at, "Unidentifiable copy"),
  ]);
  const storage = new InMemoryCollectorStorage();
  const views = await new CollectorCommand(storage).run(["scan", "--once", "--config", config]);
  assert.equal(views.length, 1);
  assert.partialDeepStrictEqual(views[0], {
    key: { harness: "claude", sessionId: "saved" }, messages: [{ text: "Recovered prompt" }],
  });
  assert.equal(await storage.readSession({ harness: "claude", sessionId: "anonymous" }), null);
});
