import assert from "node:assert/strict";
import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Batch } from "#src/storage/collector-storage";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";
import { ClaudeProjectFixture as Claude } from "../../fixtures/claude-project-fixture.ts";
import { CodexRolloutFixture as Codex } from "../../fixtures/codex-rollout-fixture.ts";
import { ConfiguredCollector } from "../../fixtures/configured-collector.ts";

const at = "2026-02-01T12:00:00Z";

for (const completeFirst of [false, true]) {
  test(`copies share a message when its native ID arrives after an earlier scan, complete copy first = ${completeFirst}`, async t => {
    const [one, two] = await Promise.all([Codex.create(), Codex.create()]);
    t.after(() => Promise.all([one.close(), two.close()]));
    const storage = new InMemoryCollectorStorage();
    const scan = (file: Codex) => ConfiguredCollector.from({ codexPath: file.home, installationId: file === one ? "one" : "two" }, storage).scanOnce();
    const event = { type: "event_msg", timestamp: at, payload: { type: "user_message", message: "Plan" } };
    const response = Codex.message(at, "Plan");
    const typed = { ...response, payload: { ...response.payload, id: "native-prompt", content: [
      { type: "input_text", text: "Pl" }, { type: "input_text", text: "an" },
    ] } };
    const rows = [Codex.header("planning"), event];
    const path = await one.write(rows);
    await two.write([...rows, typed]);
    if (completeFirst) await scan(two);
    await scan(one);
    await appendFile(path, JSON.stringify(typed) + "\n");
    const [late] = await scan(one);
    assert.deepEqual(late.messages.map(m => m.text), ["Pl", "an"]);
    const [view] = await scan(two);
    assert.deepEqual(view.messages.map(m => [m.id, m.text, m.blockIndex]),
      [["native:native-prompt:0", "Pl", 0], ["native:native-prompt:1", "an", 1]]);
  });
}

test("anonymous Claude rows converge across copied roots while identical prompts at different positions survive", async t => {
  const [one, two] = await Promise.all([Codex.create(), Codex.create()]);
  t.after(() => Promise.all([one.close(), two.close()]));
  const storage = new InMemoryCollectorStorage();
  for (const home of [one.home, two.home]) {
    const root = join(home, "claude");
    const projects = new Claude(root);
    const row = Claude.user("planning", at, "Again?");
    await projects.write("planning", "planning", [row, row]);
    await ConfiguredCollector.from({ codexPath: home, claudePath: root, installationId: home }, storage).scanOnce();
  }
  const view = await storage.readSession({ harness: "claude", sessionId: "planning" });
  assert.deepEqual(view?.messages.map(m => m.text), ["Again?", "Again?"]);
});

test("a verified pre-repair checkpoint replaces misdecoded text and the next scan leaves its version stable", async t => {
  const home = await Codex.create();
  t.after(() => home.close());
  const storage = new InMemoryCollectorStorage();
  const header = Codex.header("planning");
  const rows = [{ ...header, payload: { ...header.payload, history_mode: "paginated" } }, Codex.message(at, "Expanded model input"),
    { type: "event_msg", timestamp: at, payload: { type: "item_completed", turn_id: "turn", item: {
      type: "UserMessage", id: "original", content: [{ type: "text", text: "Actual question" }],
    } } }];
  await home.write(rows);
  const scanner = () => ConfiguredCollector.from({ codexPath: home.home, installationId: "desktop" }, storage);
  const commit = storage.commit.bind(storage);
  const oldWriter = t.mock.method(storage, "commit", (batch: Batch) => {
    const { evidenceVersion: _old, ...checkpoint } = batch.checkpoint;
    const previous = JSON.parse(checkpoint.parserState);
    delete previous.decoder.chat.paginated;
    return commit({ ...batch, checkpoint: { ...checkpoint, parserState: JSON.stringify(previous) }, messageOrigins: undefined,
      messages: [{ id: "legacy-text", text: "Expanded model input", sourceOrder: 2, blockIndex: 0, at, role: "user" }] });
  });
  await scanner().scanOnce();
  oldWriter.mock.restore();
  const key = { harness: "codex", sessionId: "planning" } as const;
  const source = { ...key, installationId: "desktop", streamId: "rollout-2026-01-31-test.jsonl" };
  assert.deepEqual((await storage.readSession(key))?.messages.map(m => m.text), ["Expanded model input"]);
  const [repaired] = await scanner().scanOnce();
  assert.deepEqual(repaired.messages.map(m => m.text), ["Actual question"]);
  const checkpoint = await storage.readCheckpoint(source);
  await scanner().scanOnce();
  assert.deepEqual(await storage.readCheckpoint(source), checkpoint);
});

test("correcting old metadata retains the branch and working directory reported by another source", async t => {
  const home = await Codex.create();
  t.after(() => home.close());
  const storage = new InMemoryCollectorStorage();
  const key = { harness: "codex", sessionId: "planning" } as const;
  await home.write([Codex.header(key.sessionId), Codex.message(at, "Plan")]);
  const scan = () => ConfiguredCollector.from({ codexPath: home.home, installationId: "desktop" }, storage).scanOnce();
  const commit = storage.commit.bind(storage);
  const oldWriter = t.mock.method(storage, "commit", (batch: Batch) => {
    const { evidenceVersion: _old, ...checkpoint } = batch.checkpoint;
    return commit({ ...batch, checkpoint, metadata: { branch: "mistaken", parentSessionId: "wrong" },
      branchObservation: { at, sourceOrder: 2 } });
  });
  await scan();
  oldWriter.mock.restore();
  const metadata = { branch: "trusted", cwd: "/work" };
  assert.equal(await commit({ source: { ...key, streamId: "another source" }, expectedVersion: 1, expectedOffset: 0,
    checkpoint: { offset: 1, parserState: "adapter" }, messages: [], usage: [], metadata,
    branchObservation: { at: "2026-01-01T00:00:00Z", sourceOrder: 1 } }), "committed");
  assert.equal((await storage.readSession(key))?.metadata.branch, "mistaken");
  assert.deepEqual((await scan())[0].metadata, metadata);
  assert.deepEqual((await scan())[0].metadata, metadata);
});

for (const replacement of [false, true]) for (const emptyState of [false, true]) {
  test(`${emptyState ? "empty" : "versioned"} pre-repair state remains visible after ${replacement ? "replacement" : "disappearance and return"}`, async t => {
    const home = await Codex.create();
    t.after(() => home.close());
    const storage = new InMemoryCollectorStorage();
    const key = { harness: "codex", sessionId: "planning" } as const;
    const rows = [Codex.header(key.sessionId), Codex.message(at, "Original plan"), Codex.tokenCount(at)];
    const path = await home.write(rows);
    const scan = () => ConfiguredCollector.from({ codexPath: home.home, installationId: "desktop" }, storage).scanOnce();
    const commit = storage.commit.bind(storage);
    const writer = t.mock.method(storage, "commit", (batch: Batch) => {
      const { evidenceVersion: _old, ...checkpoint } = batch.checkpoint;
      if (emptyState) checkpoint.parserState = replacement ? "" : "{}";
      return commit({ ...batch, checkpoint, messageOrigins: undefined });
    });
    const [before] = await scan();
    writer.mock.restore();
    assert.equal(before.coverage, "reported");
    if (replacement) await home.write([Codex.header(key.sessionId), Codex.message(at, "New plan")]);
    else await rm(path);
    const [uncertain] = await scan();
    assert.equal(uncertain.observedTotalTokens, before.observedTotalTokens);
    assert.equal(uncertain.coverage, "partial");
    assert.deepEqual(uncertain.usageDiagnostics?.map(row => row.code), ["unverified-source-history"]);
    assert.deepEqual(uncertain.messages.map(row => row.text), replacement ? ["Original plan", "New plan"] : ["Original plan"]);
    if (!replacement) {
      await home.write(rows);
      assert.deepEqual((await scan())[0], before);
    } else assert.deepEqual((await scan())[0], uncertain);
  });
}
