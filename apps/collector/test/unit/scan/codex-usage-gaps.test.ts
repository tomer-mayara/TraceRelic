import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexUsage } from "#src/scan/codex-usage";
import { CodexUsageFixture as F } from "../../fixtures/codex-usage-fixture.ts";

test("a damaged record separates the counters and request context on either side of it", () => {
  const rows = F.entries(
    F.header(), F.report(F.counts(60, 10), F.counts(60, 10), { request_id: "first" }),
    F.record("turn_context", { turn_id: "old", request_id: "stale", model: "old-model" }),
    F.event("user_message", "damaged"), F.report(undefined, F.counts(3, 1)),
    F.report(undefined, F.counts(16, 4), { request_id: "second" }),
    F.report(F.counts(200, 30)), F.report(F.counts(209, 32)),
  );
  const parser = CodexUsage.resume();
  const before = parser.decodeBatch([...rows.slice(0, 3), ...rows.slice(4, 6)], [F.damaged(4)]);
  assert.deepEqual(before.usage.map(call => [call.requestId, call.inputTokens, call.outputTokens]), [["second", 16, 4]]);
  assert.equal(before.usage[0].turnId, undefined);
  assert.equal(before.usage[0].model, undefined);
  assert.deepEqual(before.usageWindows.flatMap(w => w.parts.map(p => p.requestId)), ["first"]);
  assert.equal(before.usageAnchors?.[0].after, undefined);
  assert.equal(before.hasGap, true);
  assert.equal(parser.awaitingBaseline, true);

  const restored = CodexUsage.resume(JSON.parse(JSON.stringify(parser.snapshot())));
  const recovered = restored.decodeBatch(rows.slice(6));
  assert.deepEqual(recovered.usageWindows.map(w => [w.start.inputTokens, w.end.inputTokens, w.parts[0].outputTokens]), [[200, 209, 2]]);
  assert.equal(restored.awaitingBaseline, false);
  assert(!("awaitingBaseline" in restored.snapshot()));
});

test("a break at the end of a batch waits through replayed observations and survives another damaged batch", () => {
  const original = F.report(F.counts(40, 4));
  const rows = F.entries(F.header(), original, F.event("user_message", "damaged"), original,
    F.event("user_message", "damaged again"), F.report(F.counts(60, 8), F.counts(7, 1), { request_id: "baseline-call" }),
    F.report(F.counts(63, 10)));
  const parser = CodexUsage.resume();
  assert(parser.decodeBatch(rows.slice(0, 2), [F.damaged(3)]).hasGap);
  assert(parser.awaitingBaseline);
  const after = CodexUsage.resume(JSON.parse(JSON.stringify(parser.snapshot())));
  assert.deepEqual(after.decodeBatch(rows.slice(3, 4), [F.damaged(5)]).usageWindows, []);
  assert(after.awaitingBaseline);
  const recovered = after.decodeBatch(rows.slice(5));
  assert.deepEqual(recovered.usage.map(call => [call.requestId, call.inputTokens]), [["baseline-call", 7]]);
  assert.deepEqual(recovered.usageWindows.flatMap(w => w.parts.map(p => [p.inputTokens, p.outputTokens])), [[3, 2]]);
  assert(!after.awaitingBaseline);
});

test("nonempty unsupported token reports diagnose their line and withhold growth across the break", () => {
  for (const fields of [
    { info: "future" }, { info: [] }, { info: { next_usage: { tokens: 500 } } },
    { info: { total_token_usage: { input_tokens: "unknown" } } }, { input_tokens: 500, output_tokens: 10 },
  ]) {
    const decoder = CodexUsage.resume();
    const rows = F.entries(F.header(), F.report(F.counts(20, 2)), F.report(undefined, undefined, fields),
      F.report(F.counts(80, 20)), F.report(F.counts(83, 22)));
    const first = decoder.decodeBatch(rows.slice(0, 3));
    assert.equal(first.hasGap, true);
    assert.deepEqual(first.usageDiagnostics, [{ code: "unsupported-codex-usage", sourceOrder: 3 }]);
    const next = decoder.decodeBatch(rows.slice(3));
    assert.deepEqual(next.usageWindows.flatMap(w => w.parts.map(p => [p.inputTokens, p.outputTokens])), [[3, 2]]);
  }
});

test("an invalid total keeps its identified last call and waits for the next reliable baseline", () => {
  const parser = CodexUsage.resume();
  const invalid = F.report({ input_tokens: -1, output_tokens: 2 }, F.counts(5, 2), { request_id: "measured" });
  const rows = F.entries(F.header(), F.report(F.counts(30, 3)), invalid,
    F.report(F.counts(100, 10), F.counts(5, 2), { request_id: "measured" }), F.report(F.counts(102, 12)));
  const result = parser.decodeBatch(rows);
  assert.deepEqual(result.usage.map(p => [p.requestId, p.inputTokens, p.outputTokens]), [["measured", 5, 2]]);
  assert.deepEqual(result.usageDiagnostics, [{ code: "unsupported-codex-usage", sourceOrder: 3 }]);
  assert.deepEqual(result.usageWindows.flatMap(w => w.parts.map(p => [p.inputTokens, p.outputTokens])), [[30, 3], [2, 2]]);
});

test("a falling counter diagnoses a new epoch even when the preceding line was lost", () => {
  const amount = F.counts(60, 10);
  const rows = F.entries(F.header(), F.report(amount, amount, { request_id: "first" }),
    F.event("user_message", "lost"), F.report(F.counts(15, 3), F.counts(5, 2), { request_id: "at-reset" }),
    F.report(F.counts(17, 4)), F.report(undefined, amount, { request_id: "first" }));
  const run = (gap: boolean) => {
    const parser = CodexUsage.resume();
    const first = parser.decodeBatch(rows.slice(0, 2), gap ? [F.damaged(3)] : []);
    const next = CodexUsage.resume(JSON.parse(JSON.stringify(parser.snapshot()))).decodeBatch(rows.slice(3));
    assert.deepEqual(next.usageDiagnostics, [{ code: "codex-counter-reset", sourceOrder: 4 }]);
    assert.equal(next.hasGap, true);
    assert.deepEqual(next.usage.map(p => p.requestId), ["at-reset"]);
    assert.deepEqual(next.usageWindows.map(w => [w.start.inputTokens, w.end.inputTokens]), [[15, 17]]);
    assert(next.usageWindows[0].historyId.startsWith(first.usageWindows[0].historyId + ":reset:"));
    return next.usageWindows[0].historyId;
  };
  assert.equal(run(true), run(false));
});

test("bookkeeping and unknown optional breakdowns preserve the reliable counter baseline", () => {
  const rows = F.entries(F.header(), F.report(F.counts(30, 3)), F.report(),
    F.report(undefined, undefined, { info: { model_context_window: 32000 }, rate_limits: {} }),
    F.record("event_msg", { type: "other", usage: "tool bookkeeping" }),
    F.report(F.counts(35, 5, { cached_input_tokens: "unavailable" }), { future_breakdown: 4 }));
  const parser = CodexUsage.resume();
  const result = parser.decodeBatch(rows);
  assert.equal(result.hasGap, false);
  assert.equal(result.usageDiagnostics, undefined);
  assert.deepEqual(result.usageWindows.map(w => [w.start.inputTokens, w.end.inputTokens]), [[0, 30], [30, 35]]);
});

test("pending baseline state supports gaps before the first record and rejects unexpected flag values", () => {
  const parser = CodexUsage.resume();
  assert(parser.decodeBatch([], [F.damaged(1)]).hasGap);
  const saved = JSON.parse(JSON.stringify(parser.snapshot()));
  assert.equal(saved.awaitingBaseline, true);
  for (const invalid of ["true", false, {}, null, 1]) assert.throws(() => CodexUsage.resume({ ...saved, awaitingBaseline: invalid }));
  const fresh = CodexUsage.resume(saved);
  const rows = F.entries(F.event("user_message", "lost"), F.header(), F.report(F.counts(30, 5)), F.report(F.counts(31, 7)));
  const result = fresh.decodeBatch(rows.slice(1));
  assert.deepEqual(result.usageWindows.flatMap(w => w.parts.map(p => [p.inputTokens, p.outputTokens])), [[1, 2]]);
});
