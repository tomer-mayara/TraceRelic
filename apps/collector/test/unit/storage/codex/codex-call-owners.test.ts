import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexCallOwners } from "#src/storage/codex/codex-call-owners";
import { batch, codexMeasurement, codexSource } from "../../../fixtures/collector-storage-fixture.ts";

const providerId = "c".repeat(64);
const noParent = () => undefined;

test("a claim names its provider call only with a digest", () => {
  const call = codexMeasurement("call:native:" + "a".repeat(64), "call", 10);
  const write = (id: string) => batch(0, 0, {
    source: codexSource, usage: [call], codexCallClaims: [{ providerId: id, usageId: call.id, ownerSessionId: codexSource.sessionId }],
  });
  assert.ok(new CodexCallOwners().prepare(write(providerId), [], noParent, false));
  assert.equal(new CodexCallOwners().prepare(write("not-a-digest"), [], noParent, false), null);
});

test("a copied claim names its verified parent for a native call ID that this write does not measure", () => {
  const child = { ...codexSource, sessionId: "child" };
  const parentOf = (id: string) => id === child.sessionId ? "parent" : undefined;
  const codexFork = { parentSessionId: "parent", inheritedThrough: { offset: 5, lineNumber: 1 } };
  const write = (usageId: string) => batch(0, 0, {
    source: child, checkpoint: { offset: 10, parserState: "{}", codexFork },
    codexCallClaims: [{ providerId, usageId, ownerSessionId: "parent" }],
  });
  assert.ok(new CodexCallOwners().prepare(write("call:native:" + "f".repeat(64)), [], parentOf, false));
  assert.equal(new CodexCallOwners().prepare(write("call:" + "f".repeat(64)), [], parentOf, false), null);
});
