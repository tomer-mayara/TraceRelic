import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexScan } from "#src/providers/codex/codex-scan";
import type { CodexRolloutEntry } from "#src/providers/index";
import { ForkEvidenceSource as F } from "../../../fixtures/codex-fork-evidence-fixture.ts";
import { ProviderHistoryStub, ScanPassFixture } from "../../../fixtures/provider-scan-fixture.ts";

const rollout = (sessionId: string, fields: { sourceFile?: string; selectionCwd?: string } = {}) =>
  ScanPassFixture.source<CodexRolloutEntry>({ sessionId, sourceFile: `/codex/sessions/2026/rollout-${sessionId}.jsonl`, ...fields });

test("each Codex source is its own group, and the first group arrives before discovery gives a second source", async () => {
  const [first, second] = [rollout("one"), rollout("two")];
  const history = new ProviderHistoryStub("/codex", [[first, second]]);
  const groups = new CodexScan(history, {}).discoverFiles({})[Symbol.asyncIterator]();
  const group = await groups.next();
  assert.deepEqual(group, { done: false, value: [first] });
  assert.equal(history.requested, 1);
  assert.deepEqual(await groups.next(), { done: false, value: [second] });
  assert.equal((await groups.next()).done, true);
});

test("a plain Codex rollout and its .zst form have the same logical name", () => {
  const scan = new CodexScan(new ProviderHistoryStub<CodexRolloutEntry>("/codex"), {});
  assert.equal(scan.logicalName("/codex/sessions/2026/01/02/rollout-one.jsonl"), "rollout-one.jsonl");
  assert.equal(scan.logicalName("/codex/archived_sessions/rollout-one.jsonl.zst"), "rollout-one.jsonl");
});

test("a Codex source is located by its logical name, and its root-based stream ID is the root and that name", () => {
  const scan = new CodexScan(new ProviderHistoryStub<CodexRolloutEntry>("/codex"), {});
  const rootStreamId = '["/codex","rollout-one.jsonl"]';
  assert.deepEqual(scan.locate(rollout("one", { sourceFile: "/codex/archived_sessions/rollout-one.jsonl.zst" })),
    { location: { root: "/codex", path: "rollout-one.jsonl" }, rootStreamId });
  const selected = scan.locate(rollout("one", { selectionCwd: "/work/app" }));
  assert.deepEqual(selected, { location: { root: "/codex", path: "rollout-one.jsonl", cwd: "/work/app" }, rootStreamId });
  assert.deepEqual(Object.keys(selected.location), ["root", "path", "cwd"]);
});

test("a later Codex discovery replaces the fork evidence that selects the parser", async () => {
  const child = F.child([F.total(80, F.after)]);
  const scan = new CodexScan(new ProviderHistoryStub("/codex", [[child], [rollout("other")]]), {});
  await Array.fromAsync(scan.discoverFiles({}));
  assert.equal((await scan.parserFor(child, null)).codexFork?.parentSessionId, "parent");
  await Array.fromAsync(scan.discoverFiles({}));
  assert.equal((await scan.parserFor(child, null)).codexFork, undefined);
});

test("a discovery of one changed Codex file also asks for the related sources, and a full discovery does not", async () => {
  const child = F.child([F.total(80, F.after)]);
  const parent = new F("parent", [F.header("parent"), F.total(80)]);
  const history = new ProviderHistoryStub("/codex", [[child, parent], [child], [child, parent]]);
  const selection = { sessionIds: ["child", "parent"] };
  const scan = new CodexScan(history, selection);
  await Array.fromAsync(scan.discoverFiles({}));
  assert.equal(history.calls.length, 1);
  const onChanged = () => {};
  await Array.fromAsync(scan.discoverFiles({ sourceFile: child.sourceFile, onChanged }));
  assert.deepEqual(history.calls.map(call => call.options), [{}, { sourceFile: child.sourceFile, onChanged }, { onChanged }]);
  assert.ok(history.calls.every(call => call.selection === selection));
});

test("a Codex pass cannot select a parser before a discovery", () => {
  const scan = new CodexScan(new ProviderHistoryStub<CodexRolloutEntry>("/codex"), {});
  assert.throws(() => scan.parserFor(rollout("one"), null), { name: "Error" });
});
