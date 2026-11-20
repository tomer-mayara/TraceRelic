import assert from "node:assert/strict";
import { appendFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { GlobalConfig } from "@tracerelic/collector/config";
import { LocalLLMHistoryClaude, type ScanSelection } from "@tracerelic/collector/history";
import { LocalCollector } from "@tracerelic/collector/scan";
import { ClaudeProjectFixture as Claude } from "../../fixtures/claude-project-fixture.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";

test("two Claude sessions in one file verify their different saved offsets together", async t => {
  const root = await Claude.create();
  t.after(() => root.close());
  const config = new GlobalConfig(join(root.home, "codex"), root.home);
  const store = new InMemoryCollectorStorage();
  const freshScan = (sessionIds?: string[]) => new LocalCollector(config, store).scanOnce({ sessionIds });
  const at = "2026-01-01T00:00:00Z";
  const a = Claude.user("a", at, "First session");
  const b = Claude.user("b", at, "Second session");
  const file = await root.write("shared-project", "transcript", [a]);
  await freshScan(["a"]);
  const firstOffset = (await stat(file)).size;
  await appendFile(file, JSON.stringify(b) + "\n");
  await freshScan(["b"]);
  const secondOffset = (await stat(file)).size;
  await appendFile(file, JSON.stringify(Claude.user("a", at, "New text")) + "\n");

  const requests: number[][] = [];
  const discover = LocalLLMHistoryClaude.prototype.discoverSources;
  t.mock.method(LocalLLMHistoryClaude.prototype, "discoverSources", async function* (
    this: LocalLLMHistoryClaude, selection?: ScanSelection,
  ) {
    for await (const source of discover.call(this, selection)) {
      yield { ...source, prefixDigests(offsets: readonly number[]) {
        requests.push([...offsets].sort((a, b) => a - b));
        return source.prefixDigests(offsets);
      } };
    }
  });
  const views = await freshScan();
  assert.deepEqual(requests, [[firstOffset, secondOffset]]);
  assert.deepEqual(views.map(view => [view.key.sessionId, view.messages.map(message => message.text)]), [
    ["a", ["First session", "New text"]], ["b", ["Second session"]],
  ]);
  const [first, second] = await Promise.all(["a", "b"].map(sessionId =>
    store.readCheckpoint({ harness: "claude", sessionId, streamId: file })));
  assert(first.checkpoint?.prefixDigest);
  assert.equal(first.checkpoint.prefixDigest, second.checkpoint?.prefixDigest);
});
