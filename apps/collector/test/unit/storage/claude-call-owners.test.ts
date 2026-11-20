import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeCallOwnershipFixture as F } from "../../fixtures/claude-call-ownership-fixture.ts";

test("a cited original row and its provider message settle a remapped request across installations", () => {
  const f = new F();
  const copy = F.row("copy", "m", "remapped", { transcriptUuid: "new", parentSessionId: "p", parentMessageUuid: "before" });
  const distinct = F.row("own", "m", "new-request");
  f.submit("c", [copy, distinct], "p", "laptop");
  assert.deepEqual(f.view("c").usage.map(row => row.requestId), ["new-request"]);
  assert.deepEqual(f.view("c").diagnostics, [{ code: "unresolved-claude-fork", sourceOrder: 1,
    byteRange: { startOffset: 0, endOffset: 20 }, streamId: "c.jsonl", installationId: "laptop" }]);
  const original = F.row("own", "m", "request", { transcriptUuid: "before" });
  assert(f.submit("p", [original], undefined, "desktop").has("c"));
  assert.deepEqual(f.view("p").usage.map(row => row.requestId), ["request"]);
  assert.deepEqual(f.view("c").usage.map(row => row.requestId), ["new-request"]);
  assert.deepEqual(f.view("c").diagnostics, []);
  assert(!f.submit("p", [original], undefined, "desktop").has("c"));
});

test("a parent takes over the identical pair from each linked agent without merging their independent requests", () => {
  const f = new F();
  const both = F.row("own", "shared-model", "same");
  for (const agent of ["worker1", "worker2"]) {
    f.submit(agent, [both, F.row("own", "shared-model", agent)], "p");
    assert.equal(f.view(agent).usage.length, 2);
  }
  f.submit("unrelated", [both]);
  const changed = f.submit("p", [both]);
  for (const agent of ["worker1", "worker2"]) {
    assert(changed.has(agent));
    assert.deepEqual(f.view(agent).usage.map(row => row.requestId), [agent]);
  }
  assert.equal(f.view("p").usage.length, 1);
  assert.equal(f.view("unrelated").usage.length, 1);
});

test("an unresolved subagent call requires native corroboration in its parent", () => {
  const f = new F();
  const first = F.row("subagent", "m", "other", { parentSessionId: "p", sourceOrder: 3, byteRange: { startOffset: 40, endOffset: 55 } });
  const later = F.row("subagent", "m", undefined, { parentSessionId: "p", sourceOrder: 4, byteRange: { startOffset: 55, endOffset: 80 } });
  f.submit("p", [F.row("own", "m", "r")]);
  f.submit("agent", [later, first], "p");
  assert.deepEqual(f.view("agent").usage, []);
  assert.deepEqual(f.view("agent").diagnostics.map(row => [row.sourceOrder, row.byteRange]), [[3, { startOffset: 40, endOffset: 55 }]]);
});

test("a verified parent request owns a copied advisor even if only a descendant recorded it", () => {
  const f = new F();
  f.submit("c", [
    F.row("copy", "m", "r", { parentSessionId: "p", transcriptUuid: "child" }),
    F.row("copy", "m", "r", { parentSessionId: "p", transcriptUuid: "child" }, "advisor"),
  ], "p");
  f.submit("g", [F.row("copy", "m", "different", { parentSessionId: "c", parentMessageUuid: "child" }, "advisor")], "c");
  const changed = f.submit("p", [F.row("own", "m", "r")]);
  assert(changed.has("c") && changed.has("g"));
  assert.deepEqual(f.view("c"), { usage: [], diagnostics: [] });
  assert.deepEqual(f.view("g"), { usage: [], diagnostics: [] });
  assert.deepEqual(f.view("p").usage.map(row => row.iterationId), [undefined, "advisor"]);
  f.submit("p", [F.row("own", "m", "r", {}, "advisor")]);
  assert.deepEqual(f.view("p").usage.map(row => row.iterationId), [undefined, "advisor"]);
});

test("a cycle or contradicted original cannot establish a copied call's owner", () => {
  const f = new F();
  const pointer = { parentSessionId: "p", parentMessageUuid: "mislabelled" };
  f.submit("c", [F.row("copy", "m", "copied", pointer)], "p");
  f.submit("p", [F.row("own", "different", "r", { transcriptUuid: "mislabelled" })]);
  assert.equal(f.view("c").diagnostics.length, 1);
  const g = new F();
  g.submit("c", [F.row("copy", "m", "r", { parentSessionId: "p" })], "p");
  g.submit("p", [F.row("copy", "m", "r", { parentSessionId: "c" })], "c");
  for (const id of ["c", "p"]) {
    assert.deepEqual(g.view(id).usage, []);
    assert.equal(g.view(id).diagnostics.length, 1);
  }
});

test("an invalid range cannot publish ownership or touch the earlier session snapshot", () => {
  const f = new F();
  const first = F.row("own", "m", "r");
  f.submit("c", [first], "p");
  const before = f.owners;
  const invalid = F.row("own", "m", "r", { byteRange: { startOffset: 70, endOffset: 101 } });
  assert.equal(before.prepare(F.batch("p", [invalid]), [F.measurement("p", invalid)]), null);
  const raw = [F.measurement("c", first)];
  assert.deepEqual(before.view("c", raw).usage, raw);
  f.submit("p", [first]);
  assert.deepEqual(f.view("c").usage, []);
  assert.deepEqual(before.view("c", raw).usage, raw);
});

test("a later independently tagged agent row can establish the owner of an unmarked observation", () => {
  const f = new F();
  const parentSessionId = "p";
  f.submit("agent", [F.row("subagent", "m", "r", { parentSessionId })], parentSessionId);
  assert.equal(f.view("agent").diagnostics.length, 1);
  const own = F.row("own", "m", "r", { parentSessionId, transcriptUuid: "live" });
  f.submit("agent", [own], parentSessionId, "laptop");
  assert.deepEqual(f.view("agent").usage, [F.measurement("agent", own)]);
  assert.deepEqual(f.view("agent").diagnostics, []);
});

test("a preserved original row UUID can identify a subagent copy with a rewritten request and an agent tag", () => {
  const f = new F();
  f.submit("p", [F.row("own", "m", "original", { transcriptUuid: "row" })]);
  f.submit("agent", [F.row("own", "m", "rewritten", { parentSessionId: "p", transcriptUuid: "row" })], "p");
  assert.deepEqual(f.view("agent"), { usage: [], diagnostics: [] });
});

test("a copied partial observation cannot adopt the child's separate request with the same model message", () => {
  const f = new F();
  f.submit("p", [F.row("own", "m", "parent-request", { transcriptUuid: "original" })]);
  const copy = { ...F.row("copy", "m", undefined, { parentSessionId: "p", parentMessageUuid: "original" }), status: "provisional" as const };
  const own = { ...F.row("own", "m", "different"), inputTokens: 20, outputTokens: 5 };
  const raw = [F.measurement("child", own)];
  f.submit("child", [own, copy], "p", "desktop", raw);
  assert.deepEqual(f.view("child").usage.map(row => [row.requestId, row.inputTokens, row.outputTokens]), [["different", 20, 5]]);
  assert.deepEqual(f.view("child").diagnostics, []);
  assert.equal(f.view("p").usage[0]?.inputTokens, 80);
});

test("a disputed parent amount still proves the identity of the call it made", () => {
  const f = new F();
  const parent = F.row("own", "m", "r");
  f.submit("p", [parent]);
  f.submit("child", [F.row("own", "m", "r", { parentSessionId: "p" })], "p");
  assert.deepEqual(f.view("child"), { usage: [], diagnostics: [] });
  f.submit("p", [{ ...parent, inputTokens: 90 }], undefined, undefined, []);
  assert.deepEqual(f.view("p").usage, []);
  assert.deepEqual(f.view("child"), { usage: [], diagnostics: [] });
});

test("a later final in a verified fork revises the parent's original call", () => {
  const f = new F();
  const parent = { ...F.row("own", "m", "r", { transcriptUuid: "p-row" }), status: "provisional" as const };
  f.submit("p", [parent]);
  const original = f.view("p").usage[0];
  const child = { ...F.row("copy", "m", "new", { parentMessageUuid: "p-row", parentSessionId: "p" }),
    at: "2026-02-01T18:00:00Z", inputTokens: 36, outputTokens: 4 };
  const changed = f.submit("c", [child], "p");
  assert(changed.has("p"));
  const revised = f.view("p").usage[0];
  assert.deepEqual([revised.id, revised.at, revised.requestId, revised.status, revised.inputTokens, revised.revision],
    [original.id, original.at, "r", "final", 36, original.revision + 1]);
  assert.deepEqual(f.view("c"), { usage: [], diagnostics: [] });
  assert(!f.submit("c", [child], "p").has("p"));
});
