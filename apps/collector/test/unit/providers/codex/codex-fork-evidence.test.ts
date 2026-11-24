import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexForkEvidence } from "#src/providers/codex/codex-fork-evidence";
import { ForkEvidenceSource as F } from "../../../fixtures/codex-fork-evidence-fixture.ts";

test("matches a copied prefix with new envelope times and stops at the parent's exact fork instant", async () => {
  const parent = new F("parent", [F.header("parent"), F.total(80), F.total(200, F.before, "shared"),
    F.total(225, "2026-06-01T11:00:00.000002Z", "later"), null]);
  const child = F.child([F.header("parent"), F.total(80, F.after), F.total(200, F.after, "shared"), F.total(225, F.after, "later")]);
  const evidence = new CodexForkEvidence([child, parent]);
  assert.equal(await evidence.assess(parent), undefined);
  assert.equal(parent.reads, 0);
  assert.deepEqual((await evidence.assess(child))?.fork, {
    parentSessionId: "parent", inheritedThrough: { lineNumber: 4, offset: 400 }, baseline: { inputTokens: 200, outputTokens: 0 },
  });
});

test("scope copy evidence to selected lineage and reject cycles and conflicting parent copies", async () => {
  const child = F.child([F.total(80, F.after), F.total(200, F.after, "shared"), F.total(225, F.after)]);
  const partial = new F("parent", [F.header("parent"), F.total(80), F.total(200, F.before, "other")]);
  const complete = new F("parent", [F.header("parent"), F.total(80), F.total(200, F.before, "shared")]);
  const missing = { parentSessionId: "parent", firstUncertain: { lineNumber: 2, offset: 100 } };
  const circular = F.child([F.total(80, F.after)], "child", "parent");
  for (const sources of [[child], [child, circular], [child, partial, complete], [complete, child, partial]]) {
    assert.deepEqual((await new CodexForkEvidence(sources).assess(child))?.fork, missing);
  }
});

test("a damaged parent prefix or conflicting call IDs cannot prove a copy by counts alone", async () => {
  const child = F.child([F.total(200, F.after, "child-call")]);
  for (const rows of [[F.header("parent"), F.total(200, F.before, "parent-call")],
    [F.header("parent"), null, F.total(200, F.before, "child-call")]]) {
    const parent = new F("parent", rows);
    assert.deepEqual((await new CodexForkEvidence([child, parent]).assess(child))?.fork,
      { parentSessionId: "parent", firstUncertain: { lineNumber: 2, offset: 100 } });
  }
});

test("a known empty parent prefix ends at the child header even when the parent later used tokens", async () => {
  const child = F.child([F.total(0, F.after), F.total(25, F.after)]);
  const parent = new F("parent", [F.header("parent"), F.total(260, F.after)]);
  assert.deepEqual((await new CodexForkEvidence([child, parent]).assess(child))?.fork,
    { parentSessionId: "parent", inheritedThrough: { offset: 100, lineNumber: 1 }, baseline: { inputTokens: 0, outputTokens: 0 } });
});

test("only usage past the fork ends the eligible parent prefix", async () => {
  const parent = new F("parent", [F.header("parent"), F.header("parent", F.after), F.total(200)]);
  const child = F.child([F.total(200, F.after), F.total(225, F.after)]);
  assert.deepEqual((await new CodexForkEvidence([child, parent]).assess(child))?.fork,
    { parentSessionId: "parent", inheritedThrough: { offset: 200, lineNumber: 2 }, baseline: { inputTokens: 200, outputTokens: 0 } });
});

test("a fragment or an unknown fork time cannot verify an empty prefix", async () => {
  const child = F.child([F.total(50, F.after)]);
  const fragmentHeader = { ...F.header("parent"), ordinal: 50 };
  const fragment = new F("parent", [fragmentHeader]);
  const undated = new F("child", child.rows, { parentSessionId: "parent" });
  const parent = new F("parent", [F.header("parent")]);
  const unresolved = { parentSessionId: "parent", firstUncertain: { offset: 100, lineNumber: 2 } };
  assert.deepEqual((await new CodexForkEvidence([child, fragment]).assess(child))?.fork, unresolved);
  assert.deepEqual((await new CodexForkEvidence([undated, parent]).assess(undated))?.fork, unresolved);
});

test("compares only the child prefix needed for this fork and resolves nested parents", async () => {
  const root = new F("root", [F.header("root"), F.total(80)]);
  const parent = new F("parent", [F.header("parent", F.before, { forked_from_id: "root", session_id: "root" }),
    F.header("root"), F.total(80), F.total(200)],
    { parentSessionId: "root", forkedAt: F.before });
  const child = F.child([F.total(80, F.after), F.total(200, F.after), F.liveTurn(), ...Array(12).fill(F.total(225, F.after))]);
  const result = await new CodexForkEvidence([child, parent, root]).assess(child);
  assert.deepEqual(result?.fork.inheritedThrough, { offset: 300, lineNumber: 3 });
  assert.equal(child.rowsRead, 3);
  const orphan = F.child(child.rows.slice(1));
  await new CodexForkEvidence([orphan]).assess(orphan);
  assert.equal(orphan.rowsRead, 2);
});

test("an unavailable parent leaves child-owned calls alone and locates the first disputed report or damaged row", async () => {
  const known = [F.liveTurn(), F.childCall("one"), F.childCall("two")];
  const independent = F.child(known);
  assert.deepEqual((await new CodexForkEvidence([independent]).assess(independent))?.fork, { parentSessionId: "parent" });
  for (const tail of [[F.total(60, F.after), F.total(80, F.after)], [null, F.total(60, F.after)]]) {
    const child = F.child([...known, ...tail]);
    assert.deepEqual((await new CodexForkEvidence([child]).assess(child))?.fork,
      { parentSessionId: "parent", firstUncertain: { lineNumber: 5, offset: 400 } });
    assert.equal(child.rowsRead, 5);
  }
});

test("a resumed or inconsistent parent header cannot establish a zero counter", async () => {
  const child = F.child([F.total(60, F.after)]);
  for (const fields of [{ resume_from: "missing-original" }, { source: "resume" }, { session_id: "another-thread" }]) {
    const parent = new F("parent", [F.header("parent", F.before, fields)]);
    assert.deepEqual(await new CodexForkEvidence([child, parent]).assess(child), {
      contradicted: false, fork: { parentSessionId: "parent", firstUncertain: { offset: 100, lineNumber: 2 } },
    });
  }
});

test("a separately identified first live call can account for the new child's full first counter", async () => {
  const parent = new F("parent", [F.header("parent"), F.total(200)]);
  const beginning = [F.liveTurn(), F.childCall("ours")];
  for (const [subtotal, sameRequest] of [[F.total(5, F.after, "ours"), true], [F.total(5, F.after, "ours", false), true],
    [F.total(5, F.after, "different"), false]] as const) {
    const child = F.child([...beginning, subtotal, F.total(25, F.after)]);
    const decision = await new CodexForkEvidence([child, parent]).assess(child);
    const fork = sameRequest ? { parentSessionId: "parent", inheritedThrough: { offset: 100, lineNumber: 1 },
      baseline: { inputTokens: 0, outputTokens: 0 } } : { parentSessionId: "parent", firstUncertain: { offset: 300, lineNumber: 4 } };
    assert.deepEqual(decision, { contradicted: false, fork });
  }
  const several = F.child([...beginning, F.childCall("second"), F.total(5, F.after, "ours")]);
  assert.equal((await new CodexForkEvidence([several, parent]).assess(several))?.fork.inheritedThrough, undefined);
});

test("a contradictory selected prefix can revoke old proof while an unavailable or incomplete prefix cannot", async () => {
  const child = F.child([F.total(200, F.after, "shared")]);
  const matching = new F("parent", [F.header("parent"), F.total(200, F.before, "shared")]);
  const different = new F("parent", [F.header("parent"), F.total(100, F.before, "other")]);
  const damaged = new F("parent", [F.header("parent"), null, F.total(100)]);
  const cycle = F.child([F.total(200)], "child", "parent");
  const lessDetail = new F("parent", [F.header("parent"), F.total(200)]);
  for (const [others, contradicted] of [
    [[], false], [[damaged], false], [[lessDetail], false], [[different], true], [[matching, different], true],
    [[damaged, matching, different], true], [[cycle], true],
  ] as const) {
    const observed = await new CodexForkEvidence([child, ...others]).assess(child);
    assert.deepEqual(observed, { contradicted, fork: { parentSessionId: "parent", firstUncertain: { offset: 100, lineNumber: 2 } } });
  }
});

test("a header-only nested parent needs evidence that its inherited counter was empty", async () => {
  const middleAt = "2026-06-01T10:30:00Z";
  const parent = new F("parent", [F.header("parent", middleAt, { forked_from_id: "root", session_id: "root" })],
    { parentSessionId: "root", forkedAt: middleAt });
  const child = F.child([F.total(225, F.after)]);
  const measured = new F("root", [F.header("root"), F.total(200, F.before)]);
  const later = new F("root", [F.header("root"), F.total(200, "2026-06-01T10:31:00Z")]);
  const zero = new F("root", [F.header("root"), F.total(0, F.before)]);
  assert.deepEqual(await new CodexForkEvidence([child, parent, measured]).assess(child), {
    fork: { parentSessionId: "parent", firstUncertain: { offset: 100, lineNumber: 2 } }, contradicted: false,
  });
  for (const root of [later, zero]) {
    assert.deepEqual(await new CodexForkEvidence([child, parent, root]).assess(child), { fork: {
      parentSessionId: "parent", inheritedThrough: { offset: 100, lineNumber: 1 }, baseline: { inputTokens: 0, outputTokens: 0 },
    }, contradicted: false });
  }
});
