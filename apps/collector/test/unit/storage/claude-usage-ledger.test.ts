import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClaudeUsageReport } from "../../../src/storage/collector-storage.ts";
import { ClaudeUsageLedger } from "#src/storage/claude-usage-ledger";
import { completed, independent, initial } from "../../fixtures/claude-usage-ledger-fixture.ts";

function commit(previous: ClaudeUsageLedger | undefined, ...reports: ClaudeUsageReport[]): ClaudeUsageLedger {
  const next = ClaudeUsageLedger.merge(previous, reports, "chat");
  assert.ok(next);
  return next;
}

test("a tool report replaces the entire provisional measurement while preserving its time, ID and order", () => {
  const start = commit(undefined, initial, independent);
  assert.equal(start.measurements.length, 2);
  const { id, at } = start.measurements[0];
  const updated = commit(start, completed);
  assert.deepEqual(updated.measurements, [
    { ...completed, at, id, kind: "call", revision: 2 }, start.measurements[1],
  ]);
  assert.equal(updated.hasGap, false);
  assert.deepEqual(commit(updated, initial, completed).measurements, updated.measurements);
  assert.equal(start.measurements[0].outputTokens, 2);
});

test("a final report wins in either arrival order, including a downward correction", () => {
  const lower = { ...completed, inputTokens: 31, outputTokens: 1 };
  const first = commit(undefined, lower);
  assert.deepEqual(commit(first, initial).measurements, first.measurements);
  const last = commit(undefined, initial, lower);
  assert.deepEqual(last.measurements.map(row => [row.inputTokens, row.outputTokens, row.status, row.revision]), [
    [31, 1, "final", 2],
  ]);
});

test("a larger provisional report supersedes the whole earlier report in either arrival order", () => {
  const larger = { ...initial, outputTokens: 91 };
  for (const [first, next, revision] of [[initial, larger, 2], [larger, initial, 1]] as const) {
    const state = commit(undefined, first, next);
    assert.deepEqual(state.measurements.map(row => [row.outputTokens, row.revision]), [[91, revision]]);
    assert.equal(state.hasGap, false);
    assert.deepEqual(commit(state, next, first).measurements, state.measurements);
  }
});

test("a crossing provisional update withholds the disputed request and keeps the independent one", () => {
  // Inclusive input grows, but ordinary input falls from 10 to 6.
  const crossing = { ...initial, inputTokens: 42, cacheReadTokens: 31, outputTokens: 91 };
  const resolved = { ...initial, inputTokens: 46, cacheReadTokens: 31, outputTokens: 95 };
  for (const [a, b] of [[initial, crossing], [crossing, initial]]) {
    const start = commit(undefined, a, independent);
    const disputed = commit(start, b);
    assert.deepEqual(disputed.measurements, [start.measurements[1]]);
    assert.equal(disputed.hasGap, true);
    assert.deepEqual(commit(disputed, a, b, b, a).measurements, disputed.measurements);
    const next = commit(disputed, resolved);
    assert.deepEqual(next.measurements, [
      { ...start.measurements[0], ...resolved, at: a.at, revision: 2 }, start.measurements[1],
    ]);
    assert.equal(next.hasGap, true);
  }
});

test("accepts a compatible cache-write breakdown and withholds a conflicting split", () => {
  const richer = { ...initial, cacheWrite5mTokens: 3, cacheWrite1hTokens: 2 };
  const valid = commit(undefined, initial, richer, initial);
  assert.deepEqual(valid.measurements.map(row => [row.cacheWrite5mTokens, row.cacheWrite1hTokens, row.revision]), [[3, 2, 2]]);
  const conflicting = { ...richer, cacheWrite5mTokens: 1, cacheWrite1hTokens: 4 };
  const disputed = commit(valid, conflicting, richer);
  assert.deepEqual(disputed.measurements, []);
  assert.equal(disputed.hasGap, true);
  const final = commit(disputed, { ...conflicting, status: "final" });
  assert.equal(final.measurements[0].cacheWrite5mTokens, 1);
});

test("an agreeing intermediate breakdown can establish which provisional report supersedes the others", () => {
  const richer = { ...initial, cacheWrite5mTokens: 3, cacheWrite1hTokens: 2 };
  const larger = { ...richer, outputTokens: 50 };
  for (const reports of [[larger, richer, initial], [larger, initial, richer], [richer, larger, initial]]) {
    const after = commit(undefined, ...reports);
    assert.deepEqual(after.measurements.map(row => [row.outputTokens, row.cacheWrite5mTokens]), [[50, 3]]);
    assert.deepEqual(commit(after, initial, richer, larger).measurements, after.measurements);
  }
});

test("a new cache field can raise inclusive input when the known ordinary input and output agree", () => {
  const sparse: ClaudeUsageReport = { at: initial.at, status: "provisional", messageId: initial.messageId,
    requestId: initial.requestId, inputTokens: 10, outputTokens: 2 };
  for (const reports of [[sparse, initial], [initial, sparse]]) {
    const accepted = commit(undefined, ...reports);
    assert.equal(accepted.hasGap, false);
    assert.deepEqual(accepted.measurements.map(row => [row.inputTokens, row.cacheWriteTokens]), [[40, 5]]);
  }
  const different = { ...sparse, inputTokens: 40 };
  for (const reports of [[different, initial], [initial, different]]) {
    const disputed = commit(undefined, ...reports);
    assert.equal(disputed.hasGap, true);
    assert.deepEqual(disputed.measurements, []);
  }
});

test("incompatible final reports remain withheld when replayed, and cannot be resolved by a provisional", () => {
  const other = { ...completed, outputTokens: 90 };
  const disputed = commit(undefined, initial, completed, other, independent);
  assert.equal(disputed.hasGap, true);
  assert.deepEqual(disputed.measurements.map(row => row.messageId), [independent.messageId]);
  assert.deepEqual(commit(disputed, other, completed, { ...initial, outputTokens: 100 }).measurements, disputed.measurements);
});

test("an initially missing identifier can arrive later without changing the measured call ID or its order", () => {
  for (const missing of ["messageId", "requestId"] as const) {
    const partial = { ...initial, [missing]: undefined };
    const before = commit(undefined, partial, independent);
    const withIds = commit(before, completed);
    assert.deepEqual(withIds.measurements, [
      { ...completed, id: before.measurements[0].id, kind: "call", revision: 2, at: initial.at }, before.measurements[1],
    ]);
    const oneId = { ...completed, messageId: missing === "requestId" ? undefined : completed.messageId,
      requestId: missing === "messageId" ? undefined : completed.requestId };
    assert.deepEqual(commit(withIds, oneId, partial).measurements, withIds.measurements);
  }
});

test("a complete pair joins earlier message-only and request-only reports in their original publication slot", () => {
  const left = { ...initial, requestId: undefined };
  const right = { ...completed, messageId: undefined, status: "provisional" as const };
  for (const [first, other] of [[left, right], [right, left]]) {
    const before = commit(undefined, first, independent, other);
    const joined = commit(before, completed);
    assert.deepEqual(joined.measurements, [
      { ...completed, id: before.measurements[0].id, kind: "call", revision: 2, at: first.at }, before.measurements[1],
    ]);
    assert.equal(joined.hasGap, false);
    assert.deepEqual(commit(joined, right, left, completed).measurements, joined.measurements);
  }
});

test("a shared ID cannot assign a one-ID update to either of two fully identified requests", () => {
  for (const shared of ["requestId", "messageId"] as const) {
    const other = { ...independent, [shared]: initial[shared] };
    const missing = shared === "messageId" ? "requestId" : "messageId";
    const partial = { ...completed, [missing]: undefined };
    for (const reports of [[initial, other, partial], [initial, partial, other], [partial, initial, other]]) {
      const after = commit(undefined, ...reports);
      assert.equal(after.hasGap, true);
      assert.deepEqual(after.measurements.map(row => [row.messageId, row.requestId, row.outputTokens]), [
        [initial.messageId, initial.requestId, initial.outputTokens], [other.messageId, other.requestId, other.outputTokens],
      ]);
      assert.deepEqual(commit(after, partial).measurements, after.measurements);
    }
  }
});

test("each advisor iteration has its own stable measurement under its request", () => {
  const first = { ...initial, iterationId: "advisor-1", model: "advisor", messageId: undefined };
  const second = { ...initial, iterationId: "advisor-2", model: "advisor" };
  const start = commit(undefined, first, initial, second);
  const revised = { ...completed, iterationId: first.iterationId, model: first.model };
  const after = commit(start, revised, second, completed);
  assert.equal(new Set(after.measurements.map(row => row.id)).size, 3);
  assert.deepEqual(after.measurements.map(row => [row.iterationId, row.outputTokens, row.id]), [
    [first.iterationId, 91, start.measurements[0].id], [undefined, 91, start.measurements[1].id],
    [second.iterationId, 2, start.measurements[2].id],
  ]);
  assert.deepEqual(commit(after, first, second, revised).measurements, after.measurements);
});

test("a malformed report leaves the previous evidence and public measurements intact", () => {
  const saved = commit(undefined, initial);
  const invalid = [
    { messageId: undefined, requestId: undefined }, { at: "bad" }, { inputTokens: Infinity }, { outputTokens: -1 },
    { cacheWrite1hTokens: 4, cacheWrite5mTokens: 2 }, { status: "made-up" },
  ];
  for (const fields of invalid) {
    const malformed = { ...completed, ...fields } as ClaudeUsageReport;
    assert.equal(ClaudeUsageLedger.merge(saved, [completed, malformed], "chat"), null);
  }
  assert.equal(saved.measurements[0].outputTokens, 2);
  const mutable = { ...initial };
  const fromCopy = commit(undefined, mutable);
  mutable.outputTokens = 700;
  assert.deepEqual(commit(fromCopy, completed).measurements, commit(saved, completed).measurements);
  const sparse: ClaudeUsageReport[] = [];
  sparse.length = 1;
  assert.equal(ClaudeUsageLedger.merge(saved, sparse, "chat"), null);
});

test("withdrawn and joined measurement IDs remain reserved after their rows leave the public view", () => {
  const sparse = commit(undefined, { ...initial, requestId: undefined }, { ...initial, messageId: undefined });
  const joined = commit(sparse, completed);
  const withdrawn = commit(joined, { ...completed, outputTokens: 90 });
  assert.equal(withdrawn.measurements.length, 0);
  assert.deepEqual([...withdrawn.measurementIds], sparse.measurements.map(row => row.id));
  assert.equal(withdrawn.measurementIds.has("legacy-call"), false);
});

test("a later numeric correction retains verified call attribution if the correcting row omits it", () => {
  const detailed = { ...initial, model: "reported-model", turnId: "turn" };
  const after = commit(undefined, detailed, completed);
  assert.deepEqual(after.measurements.map(row => [row.model, row.turnId]), [["reported-model", "turn"]]);
  const enriched = commit(undefined, initial, detailed, initial);
  assert.equal(enriched.measurements[0].model, "reported-model");
  assert.deepEqual(commit(enriched, detailed).measurements, enriched.measurements);
});

test("equal final counts can gain attribution once and retain their tokens when two sources disagree on the model", () => {
  const start = commit(undefined, completed, independent);
  const detailed = { ...completed, at: "2026-02-02T08:00:00Z", model: "model-a", turnId: "turn" };
  const enriched = commit(start, detailed, completed);
  const expected = { ...start.measurements[0], model: detailed.model, turnId: detailed.turnId, revision: 2 };
  assert.deepEqual(enriched.measurements, [expected, start.measurements[1]]);
  assert.deepEqual(commit(enriched, completed, detailed).measurements, enriched.measurements);

  const other = { ...detailed, model: "model-b" };
  const disputed = commit(enriched, other);
  const [call] = disputed.measurements;
  assert.deepEqual([call.id, call.at, call.model, call.turnId, call.revision, call.inputTokens, call.outputTokens],
    [expected.id, completed.at, undefined, detailed.turnId, 3, 40, 91]);
  assert.equal(disputed.hasGap, false);
  assert.deepEqual(commit(disputed, other, completed, detailed).measurements, disputed.measurements);
});
