import assert from "node:assert/strict";
import { appendFile, copyFile, stat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { GlobalConfig } from "@tracerelic/collector/config";
import { LocalLLMHistoryCodex, type CodexRollout, type CodexSelection } from "@tracerelic/collector/history";
import { CodexRolloutFixture as Rollout } from "../../fixtures/codex-rollout-fixture.ts";

test("selects Codex rollouts by their first native header within the configured workspace root", async t => {
  const configured = await Rollout.create();
  t.after(() => configured.close());
  const elsewhere = await Rollout.create();
  t.after(() => elsewhere.close());
  t.mock.property(process, "env", { ...process.env, CODEX_HOME: elsewhere.home, CODEX_PATH: elsewhere.home });

  const project = "/work/search";
  const active = await configured.write([
    Rollout.header(""),
    { type: "session_meta", payload: { id: "active", cwd: project + "/frontend" } },
    { type: "session_meta", payload: { id: "copied", cwd: "/other" } },
  ]);
  await configured.write([{ type: "session_meta", payload: { session_id: "archived", cwd: project + "-old" } }], true);
  const outside = await elsewhere.write([Rollout.header("outside")]);
  await copyFile(outside, join(configured.home, "rollout-ignored.jsonl"));
  await symlink(dirname(outside), join(dirname(active), "other-directory"), "dir");

  const reader = new LocalLLMHistoryCodex(new GlobalConfig(configured.home));
  const sessionIds = async (selection?: CodexSelection) => {
    const ids: string[] = [];
    for await (const rollout of reader.readRollouts(selection)) ids.push(rollout.sessionId);
    return ids.sort();
  };
  assert.deepEqual(await sessionIds(), ["active", "archived"]);
  assert.deepEqual(await sessionIds({ sessionIds: [], projectPaths: [] }), ["active", "archived"]);
  assert.deepEqual(await sessionIds({ sessionIds: ["archived"] }), ["archived"]);
  assert.deepEqual(await sessionIds({ projectPaths: [project] }), ["active"]);
  assert.deepEqual(await sessionIds({ projectPaths: [project + "-old"] }), ["archived"]);
  assert.deepEqual(await sessionIds({ sessionIds: ["archived"], projectPaths: [project] }), ["active", "archived"]);
  assert.deepEqual(await sessionIds({ sessionIds: ["outside", "copied"], projectPaths: ["/other"] }), []);
});

test("returns undated Codex metadata and the byte position after the last decoded record", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const header = { type: "session_meta", payload: { id: "c1" } };
  const context = { type: "turn_context", payload: { turn_id: "t1", cwd: "/work/here" } };
  const message = Rollout.message("2026-02-01T08:00:00Z", "Plan 🌱");
  const sourceFile = await fixture.write([header]);
  const headerEnd = (await stat(sourceFile)).size;
  const throughContext = "broken\n" + JSON.stringify(context) + "\r\n";
  await appendFile(sourceFile, throughContext + JSON.stringify(message) + "\r\n");
  const { size } = await stat(sourceFile);
  await appendFile(sourceFile, "null\n" + JSON.stringify(Rollout.message(message.timestamp, "Unfinished")));

  const reader = new LocalLLMHistoryCodex(new GlobalConfig(fixture.home));
  const rollouts: CodexRollout[] = [];
  for await (const rollout of reader.readRollouts()) rollouts.push(rollout);
  assert.equal(rollouts.length, 1);
  const [rollout] = rollouts;
  assert.equal(rollout.sessionId, "c1");
  assert.equal(rollout.sourceFile, sourceFile);
  assert.equal(rollout.endOffset, size);
  assert.deepEqual(rollout.entries.map(entry => entry.endOffset), [headerEnd, headerEnd + Buffer.byteLength(throughContext), size]);
  assert.deepEqual(rollout.entries.map(entry => [entry.harness, entry.sessionId, entry.sourceFile, entry.lineNumber, entry.timestamp, entry.record]), [
    ["codex", "c1", sourceFile, 1, undefined, header],
    ["codex", "c1", sourceFile, 3, undefined, context],
    ["codex", "c1", sourceFile, 4, message.timestamp, message],
  ]);
});
