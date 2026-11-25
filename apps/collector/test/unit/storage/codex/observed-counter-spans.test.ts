import assert from "node:assert/strict";
import { test } from "node:test";
import { ObservedCounterSpans } from "#src/storage/codex/observed-counter-spans";
import { counts, history } from "../../../fixtures/usage-windows-fixture.ts";

const interval = (start: number, end: number, from: string, to: string, source: string) => ({
  window: { historyId: history, start: counts(start, 0), end: counts(end, 0), boundaryObservations: { start: from, end: to }, parts: [] },
  sources: [source],
});

test("a shared start is found after an interval that only one epoch recorded", () => {
  const fine = [interval(0, 5, "a", "b", "copy"), interval(5, 10, "b", "c", "copy")];
  assert.deepEqual(ObservedCounterSpans.shared(fine, [interval(5, 12, "b", "z", "rollout")]),
    [{ left: { first: 1, limit: 2 }, right: { first: 0, limit: 1 }, verified: false }]);
});

test("a span stops at a counter gap between two intervals of one epoch", () => {
  const gap = [interval(0, 5, "a", "b", "copy"), interval(6, 10, "b", "c", "copy")];
  assert.deepEqual(ObservedCounterSpans.shared(gap, [interval(0, 10, "a", "c", "rollout")]),
    [{ left: { first: 0, limit: 1 }, right: { first: 0, limit: 1 }, verified: false }]);
});
