import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { GlobalConfig } from "@tracerelic/collector/config";
import { ClaudeProjectFixture as Claude } from "../../fixtures/claude-project-fixture.ts";
import { ClaudeUsageFixture } from "../../fixtures/claude-usage-fixture.ts";
import { ConfiguredCollector } from "../../fixtures/configured-collector.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";
import { appendTranscriptBytes } from "../../fixtures/transcript-gap-fixture.ts";

test("shared Claude files report unreadable ranges to each selected session and decoded usage errors to their owner", async t => {
  const root = await Claude.create();
  t.after(() => root.close());
  const store = new InMemoryCollectorStorage();
  const config = new GlobalConfig(join(root.home, "codex"), root.home);
  const scan = (sessionIds?: string[]) => ConfiguredCollector.from(config, store).scanOnce({ sessionIds });
  const at = "2026-01-01T00:00:00Z";
  const file = await root.write("group", "mixed", [Claude.user("a", at, "é"), Claude.assistant("b", at, "reply")]);
  await scan();

  const badUsage = ClaudeUsageFixture.row({ input_tokens: "private unsupported usage", output_tokens: 1 }, {}, { sessionId: "a" });
  const knownRange = await appendTranscriptBytes(file, JSON.stringify(badUsage) + "\r\n");
  const [a, b] = await scan();
  const identifiable = { code: "invalid-claude-usage", streamId: file, sourceOrder: 3, byteRange: knownRange };
  assert.deepEqual(a.usageDiagnostics, [identifiable]);
  assert.equal(a.coverage, "unknown");
  assert.equal(a.observedTotalTokens, null);
  assert.equal(b.coverage, "reported");
  assert.equal(b.observedTotalTokens, 72);
  assert.equal(b.usageDiagnostics, undefined);

  const range = await appendTranscriptBytes(file, '{"type":"private raw line"\n');
  const unidentified = { code: "malformed-transcript-line", streamId: file, sourceOrder: 4, byteRange: range };
  const [selected] = await scan(["a"]);
  assert.deepEqual(selected.usageDiagnostics, [identifiable, unidentified]);
  assert.deepEqual(await store.readSession(b.key), b);
  const [first, second] = await scan();
  assert.deepEqual(first, selected);
  assert.deepEqual(second.usageDiagnostics, [unidentified]);
  assert.equal(second.coverage, "partial");
  assert.equal(second.observedTotalTokens, b.observedTotalTokens);
  assert.deepEqual(second.usage, b.usage);
  assert.deepEqual(await scan(), [first, second]);
});
