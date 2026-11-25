import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageWindow } from "@tracerelic/collector/storage";
import { UsageWindows } from "#src/storage/codex/usage-windows";
import {
  archivedCopy, coarse, counts, earlier, first, history, last, later, mayCover, rollout, window, zero,
} from "../../../fixtures/usage-windows-fixture.ts";

test("a copy publishes a finer partition only after both ends of the established interval are covered", () => {
  const original = UsageWindows.merge(undefined, [coarse], rollout);
  assert.ok(original);
  const incomplete = UsageWindows.merge(original, [later], archivedCopy);
  assert.ok(incomplete);
  assert.deepEqual(incomplete.measurements, coarse.parts);
  assert.equal(incomplete.hasGap, false);
  const complete = UsageWindows.merge(incomplete, [earlier], archivedCopy);
  assert.ok(complete);
  assert.deepEqual(complete.measurements, [...earlier.parts, ...later.parts]);
  assert.equal(complete.hasGap, false);
  assert.deepEqual(original.measurements, coarse.parts);
  assert.deepEqual(incomplete.measurements, coarse.parts);

  const replay = UsageWindows.merge(complete, [coarse, earlier, later], rollout);
  assert.deepEqual(replay?.measurements, complete.measurements);
  assert.equal(replay?.hasGap, false);
  assert.strictEqual(UsageWindows.merge(complete, [], rollout), complete);
});

test("coarse replay preserves detail even when the fine copy was read first, and a later split composes", () => {
  const fine = UsageWindows.merge(undefined, [earlier, later], archivedCopy);
  assert.ok(fine);
  const unchanged = UsageWindows.merge(fine, [coarse], rollout);
  assert.ok(unchanged);
  const middle = counts(30, 20);
  const start = window(zero, middle, "first call", "call");
  const end = window(middle, first, "rest");
  const append = window(last, counts(180, 50), "appended");
  const refined = UsageWindows.merge(unchanged, [start, end, append, coarse], rollout);
  assert.deepEqual(refined?.measurements, [...start.parts, ...end.parts, ...later.parts, ...append.parts]);
  assert.equal(refined?.hasGap, false);
});

test("a call in the same span refines an interval and conflicting call identities retain the established measurement", () => {
  const observed = window(zero, last, "identified", "call");
  const detailed = UsageWindows.merge(undefined, [coarse, observed, coarse], rollout);
  assert.ok(detailed);
  assert.deepEqual(detailed.measurements, observed.parts);
  assert.equal(detailed.hasGap, false);
  const conflict = UsageWindows.merge(detailed, [window(zero, last, "other", "call")], archivedCopy);
  assert.deepEqual(conflict?.measurements, observed.parts);
  assert.equal(conflict?.hasGap, true);
});

test("a partition must preserve known call evidence as well as both token totals", () => {
  const original = { ...coarse, parts: [...earlier.parts, ...later.parts] };
  const recorded = UsageWindows.merge(undefined, [original], rollout);
  assert.ok(recorded);
  const otherCall = window(first, last, "different call", "call");
  const disputed = UsageWindows.merge(recorded, [earlier, otherCall], archivedCopy);
  assert.deepEqual(disputed?.measurements, original.parts);
  assert.equal(disputed?.hasGap, true);
});

test("crossing ranges and a different rollout origin withhold disputed usage", () => {
  const original = UsageWindows.merge(undefined, [earlier], rollout);
  assert.ok(original);
  const crossed = window(counts(60, 20), last, "crossing");
  for (const addition of [crossed, { ...later, historyId: "verified:different-origin" }]) {
    const result = UsageWindows.merge(original, [addition], archivedCopy);
    assert.deepEqual(result?.measurements, earlier.parts);
    assert.equal(result?.hasGap, true);
  }
});

test("after a reset the same stream can account for new deltas even if the counter values repeat", () => {
  const base = UsageWindows.merge(undefined, [earlier], rollout);
  assert.ok(base);
  const afterReset = {
    ...window(counts(20, 5), counts(35, 10), "after reset"),
    historyId: history + ":reset:recorded-drop",
  };
  const result = UsageWindows.merge(base, [afterReset], rollout);
  assert.ok(result);
  assert.deepEqual(result.measurements, [...earlier.parts, ...afterReset.parts]);
  assert.deepEqual(UsageWindows.merge(result, [afterReset], archivedCopy)?.measurements, result.measurements);
});

test("invalid windows reject the entire write and retain pending and visible measurements", () => {
  const previous = UsageWindows.merge(undefined, [coarse, earlier], rollout);
  assert.ok(previous);
  const badBreakdown = {
    ...later, start: { ...first, cacheReadTokens: 20 }, end: { ...last, cacheReadTokens: 30 },
    parts: [{ ...later.parts[0], cacheReadTokens: 9 }],
  };
  const invalid = [
    { ...later, historyId: "" }, { ...later, start: null }, { ...later, parts: [] },
    { ...later, start: counts(170, 35) },
    { ...later, parts: [{ ...later.parts[0], inputTokens: 69, outputTokens: 11 }] },
    { ...later, parts: [{ ...later.parts[0], kind: undefined }] },
    { ...later, parts: [{ ...later.parts[0], kind: "interval", turnId: "unverified" }] },
    { ...later, parts: [{ ...later.parts[0], at: "invalid" }] },
    { ...later, parts: [later.parts[0], { ...later.parts[0], inputTokens: 0, outputTokens: 0 }] },
    badBreakdown,
  ];
  for (const value of invalid) {
    assert.equal(UsageWindows.merge(previous, [later, value as UsageWindow], archivedCopy), null);
    assert.deepEqual(previous.measurements, coarse.parts);
    assert.equal(previous.hasGap, false);
  }
  assert.deepEqual(UsageWindows.merge(previous, [later], archivedCopy)?.measurements, [...earlier.parts, ...later.parts]);
});

test("a conflicting known breakdown at a partition boundary withholds the proposed replacement", () => {
  const left = { ...earlier, end: { ...first, cacheReadTokens: 30 } };
  const right = { ...later, start: { ...first, cacheReadTokens: 10 } };
  const result = UsageWindows.merge(undefined, [coarse, left, right], rollout);
  assert.deepEqual(result?.measurements, coarse.parts);
  assert.equal(result?.hasGap, true);
});

test("a conflicting known breakdown in the parts of a partition preserves the established interval", () => {
  const original = { ...coarse, parts: [{ ...coarse.parts[0], cacheReadTokens: 20 }] };
  const left = { ...earlier, parts: [{ ...earlier.parts[0], cacheReadTokens: 10 }] };
  const right = { ...later, parts: [{ ...later.parts[0], cacheReadTokens: 8 }] };
  const result = UsageWindows.merge(undefined, [original, left, right], rollout);
  assert.deepEqual(result?.measurements, original.parts);
  assert.equal(result?.hasGap, true);
});

test("an enclosing coarse copy supplies measured coverage while either end of the fine copy is still missing", () => {
  for (const [partial, remaining] of [[earlier, later], [later, earlier]]) {
    const fine = UsageWindows.merge(undefined, [partial], archivedCopy);
    assert.ok(fine);
    const enclosing = UsageWindows.merge(fine, [coarse], rollout);
    assert.ok(enclosing);
    assert.deepEqual(enclosing.measurements, coarse.parts);
    assert.equal(enclosing.hasGap, false);
    const complete = UsageWindows.merge(enclosing, [remaining], archivedCopy);
    assert.deepEqual(complete?.measurements, [...earlier.parts, ...later.parts]);
    assert.equal(complete?.hasGap, false);
  }
});

test("known call attribution and its first recorded time survive a copy of the same native request", () => {
  const observed = window(zero, first, "native-call", "call");
  observed.parts[0].requestId = "request-1";
  const copy = {
    ...observed, parts: [{ ...observed.parts[0], at: "2026-01-01T01:00:00Z", model: "saved-model" }],
  };
  const result = UsageWindows.merge(undefined, [observed, copy], rollout);
  assert.deepEqual(result?.measurements, [{ ...observed.parts[0], model: "saved-model" }]);
  assert.equal(result?.hasGap, false);
  assert.ok(result);
  const contradictory = { ...copy, parts: [{ ...copy.parts[0], model: "different-model" }] };
  assert.equal(UsageWindows.merge(result, [contradictory], archivedCopy)?.hasGap, true);
});

test("only another source's published and unattributed range can cover a loose call after a known baseline", () => {
  const base = UsageWindows.merge(undefined, [coarse], rollout);
  assert.ok(base);
  const afterStart = { usageId: "loose", historyId: history, after: first };
  assert.equal(mayCover(base, afterStart, archivedCopy), true);
  assert.equal(mayCover(base, { ...afterStart, after: last }, archivedCopy), false);
  assert.equal(mayCover(base, { ...afterStart, after: undefined }, archivedCopy), true);
  assert.equal(mayCover(base, { ...afterStart, after: undefined }, rollout), false);
  const staged = UsageWindows.merge(base, [later], archivedCopy);
  assert.ok(staged);
  assert.equal(mayCover(staged, afterStart, archivedCopy), true);
  const published = UsageWindows.merge(staged, [earlier], archivedCopy);
  assert.ok(published);
  assert.equal(mayCover(published, afterStart, { ...rollout, streamId: "third" }), false);
  assert.equal(mayCover(published, { ...afterStart, historyId: "verified:different" }, rollout), true);
  assert.equal(mayCover(published, { ...afterStart, historyId: history + ":reset:drop" }, rollout), false);
});

test("a loose call before the first reliable snapshot stays visible alongside later deltas in its own copy", () => {
  const historyId = "unverified:physical-path";
  const base = UsageWindows.merge(undefined, [{ ...window(first, last, "delta"), historyId }], rollout);
  assert.ok(base);
  const loose = { usageId: "before-snapshot", historyId };
  assert.equal(mayCover(base, loose, rollout), false);
  const otherInstallation = { ...rollout, installationId: "elsewhere" };
  assert.equal(mayCover(base, loose, otherInstallation), true);
  const attempt = UsageWindows.merge(base, [{ ...earlier, historyId }], otherInstallation);
  assert.equal(attempt?.hasGap, true);
  assert.deepEqual(attempt?.measurements, base.measurements);
});

test("a copy must identify an established reset before it can prove a further reset on the same lineage", () => {
  const firstEpoch = { ...earlier, historyId: history + ":reset:first", parts: [{ ...earlier.parts[0], id: "first-epoch" }] };
  const nextEpoch = { ...earlier, historyId: history + ":reset:next", parts: [{ ...earlier.parts[0], id: "next-epoch" }] };
  const original = UsageWindows.merge(undefined, [earlier, firstEpoch], rollout);
  assert.ok(original);
  const prefix = UsageWindows.merge(original, [earlier], archivedCopy);
  assert.ok(prefix);
  const uncertain = UsageWindows.merge(prefix, [nextEpoch], archivedCopy);
  assert.ok(uncertain);
  assert.deepEqual(uncertain.measurements, original.measurements);
  assert.equal(uncertain.hasGap, true);
  assert.equal(mayCover(uncertain, { usageId: "loose", historyId: nextEpoch.historyId }, archivedCopy), true);
  const proven = UsageWindows.merge(uncertain, [firstEpoch, nextEpoch], archivedCopy);
  assert.deepEqual(proven?.measurements, [...original.measurements, ...nextEpoch.parts]);
  assert.deepEqual(UsageWindows.merge(original, [nextEpoch], rollout)?.measurements, proven?.measurements);
});

test("unmatched ranges can add independent native calls when every accepted token belongs to another native call", () => {
  const established = window(zero, first, "request-a", "call");
  const base = UsageWindows.merge(undefined, [established], rollout);
  assert.ok(base);
  const otherOrigin = "verified:unrelated";
  const native = { ...later, historyId: otherOrigin };
  const anonymous = {
    ...earlier, historyId: otherOrigin, parts: [{ ...earlier.parts[0], id: "call:unidentified", kind: "call" as const }],
  };
  const independent = UsageWindows.merge(base, [native, anonymous, native], archivedCopy);
  assert.ok(independent);
  assert.deepEqual(independent.measurements, [...established.parts, ...native.parts]);
  assert.equal(independent.hasGap, true);

  const unattributed = window(first, last, "extra");
  const uncertain = UsageWindows.merge(independent, [unattributed], rollout);
  assert.deepEqual(uncertain?.measurements, [...established.parts, ...unattributed.parts]);
  const fallback = { ...established, parts: [{ ...established.parts[0], requestId: undefined, id: "anonymous" }] };
  const noNativeId = UsageWindows.merge(undefined, [fallback, native], archivedCopy);
  assert.deepEqual(noNativeId?.measurements, fallback.parts);
  assert.equal(noNativeId && mayCover(noNativeId, { usageId: "loose", historyId: otherOrigin }, archivedCopy), true);
});

test("a window proves its boundary observations only with two digests", () => {
  const boundaryObservations = { start: "a".repeat(64), end: "b".repeat(64) };
  assert.equal(UsageWindows.isWindow({ ...later, boundaryObservations }), true);
  for (const proof of [{ ...boundaryObservations, start: "not-a-digest" }, { ...boundaryObservations, end: "not-a-digest" }]) {
    assert.equal(UsageWindows.isWindow({ ...later, boundaryObservations: proof }), false);
  }
});
