import assert from "node:assert/strict";
import { copyFile, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { GlobalConfig } from "@tracerelic/collector/config";
import { ScanRejectedError } from "@tracerelic/collector/scan";
import { ClaudeProjectFixture as Claude } from "../../fixtures/claude-project-fixture.ts";
import { CodexRolloutFixture as Codex } from "../../fixtures/codex-rollout-fixture.ts";
import { ConfiguredCollector } from "../../fixtures/configured-collector.ts";
import { RejectingBatchStorage } from "../../fixtures/rejecting-batch-storage.ts";

const at = "2026-02-01T12:00:00Z";

test("a rejected Codex batch stops its stream across copies and preserves other writes to the session", async t => {
  const codex = await Codex.create();
  t.after(() => codex.close());
  const claude = new Claude(join(codex.home, "claude"));
  const config = new GlobalConfig(codex.home, claude.home, "desktop");

  const prefix = [Codex.header("a"), Codex.message(at, "accepted")];
  // An oversized record occupies its own batch between the accepted prefix and the tail.
  const invalid = { ...Codex.message(at, "rejected"), padding: "x".repeat(256 * 1024) };
  const records = [...prefix, invalid, Codex.message(at, "later")];
  const active = await codex.write(records);
  const archive = await codex.write([Codex.header("a"), Codex.message(at, "another stream")], true);
  await rename(archive, join(dirname(archive), "rollout-another.jsonl"));
  await copyFile(active, archive);
  await claude.write("project", "b", [Claude.user("b", at, "another session")]);

  const storage = new RejectingBatchStorage(batch => batch.messages.some(message => message.text === "rejected"));
  const result: unknown = await ConfiguredCollector.from(config, storage).scanOnce().catch((error: unknown) => error);
  assert(result instanceof ScanRejectedError);
  const source = { harness: "codex", sessionId: "a", streamId: basename(active), installationId: "desktop" } as const;
  const startOffset = Buffer.byteLength(prefix.map(record => JSON.stringify(record) + "\n").join(""));
  const endOffset = startOffset + Buffer.byteLength(JSON.stringify(invalid) + "\n");
  assert.deepEqual(storage.attempts.filter(batch => batch.source.streamId === source.streamId)
    .map(batch => [batch.expectedOffset, batch.checkpoint.offset]), [[0, startOffset], [startOffset, endOffset]]);
  const saved = await storage.readCheckpoint(source);
  assert.deepEqual(saved.checkpoint, storage.attempts[0].checkpoint);
  const a = await storage.readSession(source);
  const b = await storage.readSession({ harness: "claude", sessionId: "b" });
  assert.deepEqual(a?.messages.map(message => message.text).sort(), ["accepted", "another stream"]);
  assert.deepEqual(b?.messages.map(message => message.text), ["another session"]);
  assert.deepEqual(result.sessions, [a, b]);
  assert.deepEqual(result.rejections, [{ status: "rejected", source, byteRange: { startOffset, endOffset } }]);
});

test("a first invalid Claude batch skips every remaining stream in that file and imports the next file", async t => {
  const claude = await Claude.create();
  t.after(() => claude.close());
  const config = new GlobalConfig(claude.home, claude.home);
  await claude.write("project", "mixed", [Claude.user("a", at, "rejected"), Claude.user("sibling", at, "skip")]);
  // Claude discovery always processes earlier copies after current files.
  await claude.write("project", "b.orphaned-1700000000000-a", [{ ...Claude.user("b", at, "accepted"), uuid: "b-1" }]);
  const storage = new RejectingBatchStorage(batch => batch.source.sessionId === "a");
  const result: unknown = await ConfiguredCollector.from(config, storage).scanOnce().catch((error: unknown) => error);
  assert(result instanceof ScanRejectedError);
  assert.deepEqual(storage.attempts.map(batch => batch.source.sessionId), ["a", "b"]);
  assert.equal(await storage.readSession({ harness: "claude", sessionId: "a" }), null);
  assert.equal(await storage.readSession({ harness: "claude", sessionId: "sibling" }), null);
  const b = await storage.readSession({ harness: "claude", sessionId: "b" });
  assert.deepEqual(b?.messages.map(message => message.text), ["accepted"]);
  assert.deepEqual(result.sessions, [b]);
});
