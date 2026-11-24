import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageWindows } from "#src/storage/codex/usage-windows";
import { archivedCopy, counts, earlier, first, last, rollout, window, zero } from "../../../fixtures/usage-windows-fixture.ts";

test("a replacement can establish the same verified counter and count later appends", () => {
  const past = UsageWindows.merge(undefined, [earlier], rollout, 0);
  assert(past);
  const loose = { usageId: "request", historyId: earlier.historyId, after: zero };
  assert.equal(past.mayCover(loose, rollout, 2), true);
  const confirmed = UsageWindows.merge(past, [earlier], rollout, 2);
  assert(confirmed);
  assert.deepEqual(confirmed.measurements, earlier.parts);
  assert.equal(confirmed.mayCover({ ...loose, after: first }, rollout, 2), false);
  assert.equal(confirmed.hasGap, false);
});

test("an unverified counter from a replaced file cannot establish continuity by path alone", () => {
  const historyId = "unverified:same-path";
  const oldWindow = { ...earlier, historyId };
  const past = UsageWindows.merge(undefined, [oldWindow], rollout, 0);
  assert(past);
  const next = { ...window(first, last, "uncertain interval"), historyId };
  const replaced = UsageWindows.merge(past, [next], rollout, 2);
  assert(replaced);
  assert.deepEqual(replaced.measurements, oldWindow.parts);
  assert.equal(replaced.hasGap, true);
  const loose = { usageId: "request", historyId, after: zero };
  assert.equal(replaced.mayCover(loose, rollout, 0), false);
  assert.equal(replaced.mayCover(loose, rollout, 2), true);
});

test("a replacement counter that would hide a larger accepted native call waits for a proven partition", () => {
  const thirty = counts(24, 6);
  const total = counts(114, 36);
  const coarse = window(zero, thirty, "uncertain 30");
  const call = window(thirty, total, "known 120", "call");
  const anchor = { usageId: "known 120", historyId: coarse.historyId, after: zero };
  const before = UsageWindows.merge(undefined, [], rollout);
  assert(before);
  const staged = UsageWindows.merge(before, [coarse], rollout, 2, [{ source: rollout, generation: 0, anchor }]);
  assert(staged);
  assert.deepEqual(staged.measurements, []);
  assert.equal(staged.hasGap, true);
  assert.equal(staged.mayCover(anchor, rollout, 0), false);
  const again = UsageWindows.merge(staged, [coarse], archivedCopy);
  assert(again);
  assert.deepEqual(again.measurements, []);
  const proven = UsageWindows.merge(again, [call], rollout, 2);
  assert(proven);
  assert.deepEqual(proven.measurements, [...coarse.parts, ...call.parts]);
});

test("competing coarse histories keep other independently identified calls visible", () => {
  const coarse = window(zero, last, "coarse 200");
  const native = window(last, counts(170, 50), "independent", "call");
  const anchor = { usageId: "original", historyId: coarse.historyId, after: zero };
  const before = UsageWindows.merge(undefined, [], rollout);
  assert(before);
  const staged = UsageWindows.merge(before, [coarse, native], rollout, 2, [{ source: rollout, generation: 0, anchor }]);
  assert(staged);
  assert.deepEqual(staged.measurements, native.parts);
  assert.equal(staged.mayCover(anchor, rollout), false);
  assert.equal(staged.hasGap, true);
});
