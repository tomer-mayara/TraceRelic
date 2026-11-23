import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexForkSources } from "#src/providers/codex/codex-fork-sources";
import { ForkEvidenceSource as F } from "../../../fixtures/codex-fork-evidence-fixture.ts";

test("omitting a grandparent from the next selection preserves a verified child boundary", async () => {
  const parent = F.child([F.total(80), F.total(200)], "grandparent", "parent");
  const child = F.child([F.total(80, F.after), F.total(200, F.after), F.total(225, F.after)]);
  const selected = new CodexForkSources((async function* () { yield child; yield parent; })());
  const [source] = await Array.fromAsync(selected.sources());
  const codexFork = { parentSessionId: "parent", inheritedThrough: { offset: 300, lineNumber: 3 },
    baseline: { inputTokens: 200, outputTokens: 0 } };
  const saved = { offset: 400, prefixDigest: "a".repeat(64), parserState: "{}", codexFork };
  const format = await selected.format(source, saved);
  assert.deepEqual(format.codexFork, codexFork);
});

test("a child-only scan locates an uncertain row again if the earlier scan had not accepted that row", async () => {
  const child = F.child([F.total(200, F.after)]);
  const selected = new CodexForkSources((async function* () { yield child; })());
  const [source] = await Array.fromAsync(selected.sources());
  const codexFork = { parentSessionId: "parent", firstUncertain: { offset: 400, lineNumber: 5 } };
  const saved = { offset: 100, prefixDigest: "a".repeat(64), parserState: "{}", codexFork };
  assert.deepEqual((await selected.format(source, saved)).codexFork,
    { parentSessionId: "parent", firstUncertain: { offset: 100, lineNumber: 2 } });
});
