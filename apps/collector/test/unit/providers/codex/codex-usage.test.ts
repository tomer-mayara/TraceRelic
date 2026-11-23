import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexUsage } from "#src/providers/codex/codex-usage";
import { CodexUsageFixture as F } from "../../../fixtures/codex-usage-fixture.ts";

test("reconciles separately identified calls, the last call and the remaining input and output", () => {
  const entries = F.entries(
    F.header(), F.report(F.counts(100, 20)),
    F.record("turn_context", { turn_id: "t1", model: "model-A" }),
    F.report(undefined, F.counts(15, 5), { request_id: "r1" }),
    F.report(F.counts(160, 40), F.counts(20, 10), { request_id: "r2" }),
    F.report(F.counts(160, 40), F.counts(20, 10), { request_id: "r2" }),
  );
  const parser = CodexUsage.resume();
  const before = parser.decodeBatch(entries.slice(0, 4));
  assert.equal(before.hasGap, false);
  assert.deepEqual(before.usage.map(c => [c.kind, c.requestId, c.inputTokens, c.outputTokens]),
    [["call", "r1", 15, 5]]);
  assert.deepEqual(before.usageAnchors, [{
    usageId: before.usage[0].id, historyId: before.usageWindows[0].historyId, after: { inputTokens: 100, outputTokens: 20 },
  }]);
  const fresh = CodexUsage.resume(JSON.parse(JSON.stringify(parser.snapshot())));
  const after = fresh.decodeBatch(entries.slice(4));
  assert.equal(after.hasGap, false);
  assert.deepEqual(after.usage, []);
  assert.equal(after.usageWindows.length, 1);
  const [window] = after.usageWindows;
  assert.deepEqual([window.start.inputTokens, window.start.outputTokens, window.end.inputTokens, window.end.outputTokens],
    [100, 20, 160, 40]);
  assert.deepEqual(window.parts.filter(p => p.kind === "call").map(p => [p.requestId, p.inputTokens, p.outputTokens, p.turnId, p.model]),
    [["r1", 15, 5, "t1", "model-A"], ["r2", 20, 10, "t1", "model-A"]]);
  assert.deepEqual(window.parts.find(p => p.requestId === "r1"), before.usage[0]);
  assert.deepEqual(window.parts.filter(p => p.kind === "interval").map(p => [p.inputTokens, p.outputTokens, p.turnId, p.requestId, p.model]),
    [[25, 5, undefined, undefined, undefined]]);
});

test("identifies the last call from a cumulative change, and ignores repeated snapshots", () => {
  const last = F.counts(5, 1);
  const update = F.report(F.counts(12, 3), last);
  const { usage, usageWindows, hasGap } = CodexUsage.resume().decodeBatch(F.entries(
    F.header(), F.record("turn_context", { turn_id: "turn", model: "model" }),
    update, update, F.report(F.counts(17, 4), last),
  ));
  assert.deepEqual(usage, []);
  assert.equal(hasGap, false);
  assert.equal(usageWindows.length, 2);
  const calls = usageWindows.flatMap(w => w.parts).filter(p => p.kind === "call");
  assert.deepEqual(calls.map(c => [c.inputTokens, c.outputTokens, c.turnId, c.model, c.requestId]),
    [[5, 1, "turn", "model", undefined], [5, 1, "turn", "model", undefined]]);
  assert.notEqual(calls[0].id, calls[1].id);
});

test("uses real request evidence for equal last-only reports, including a request in turn context", () => {
  const amount = F.counts(3, 2);
  const parser = CodexUsage.resume();
  const entries = F.entries(F.header(), F.report(undefined, amount),
    F.record("turn_context", { turn_id: "A", model: "first", request_id: "a" }),
    F.report(undefined, amount), F.report(undefined, amount),
    F.record("event_msg", { type: "task_complete", turn_id: "A" }),
    F.report(undefined, amount, { request_id: "b" }), F.report(F.counts(6, 4), amount, { request_id: "b" }));
  const unidentified = parser.decodeBatch(entries.slice(0, 2));
  assert.deepEqual(unidentified.usage, []);
  assert.deepEqual(unidentified.usageWindows, []);
  assert.equal(unidentified.hasGap, true);
  const accepted = parser.decodeBatch(entries.slice(2));
  assert.deepEqual(accepted.usage.map(c => [c.requestId, c.turnId, c.model]),
    [["a", "A", "first"], ["b", undefined, undefined]]);
  assert.deepEqual(accepted.usageWindows[0].parts, accepted.usage);
});

test("keeps inclusive input and output, and assigns only reliable breakdowns to the residual", () => {
  const baseline = F.counts(50, 10, { cached_input_tokens: 30, cache_write_input_tokens: 5, reasoning_output_tokens: 4 });
  const end = F.counts(80, 20, { cached_input_tokens: 41, cache_write_input_tokens: 8, reasoning_output_tokens: 9 });
  const last = F.counts(15, 4, { cached_input_tokens: 6, cache_write_input_tokens: 1, reasoning_output_tokens: 2 });
  const { usageWindows } = CodexUsage.resume().decodeBatch(F.entries(F.header(), F.report(baseline), F.report(end, last)));
  assert.deepEqual(usageWindows.flatMap(w => w.parts).map(p =>
    [p.kind, p.inputTokens, p.outputTokens, p.cacheReadTokens, p.cacheWriteTokens, p.reasoningTokens]),
    [["interval", 50, 10, 30, 5, 4], ["call", 15, 4, 6, 1, 2], ["interval", 15, 6, 5, 2, 3]]);
});

test("empty and rate-limit events have no measurement, while an explicit zero is stored once", () => {
  const parser = CodexUsage.resume();
  const entries = F.entries(F.header(), F.report(), F.report(undefined, undefined, { info: null, rate_limits: { used_percent: 20 } }),
    F.report(F.counts(0, 0)), F.report(F.counts(0, 0)));
  assert.deepEqual(parser.decodeBatch(entries.slice(0, 3)), { usage: [], usageWindows: [], hasGap: false });
  const result = parser.decodeBatch(entries.slice(3));
  const parts = [...result.usage, ...result.usageWindows.flatMap(w => w.parts)];
  assert.deepEqual(parts.map(p => [p.inputTokens, p.outputTokens]), [[0, 0]]);
  assert.equal(result.hasGap, false);
});

test("two genuinely distinct zero-token calls can share a cumulative counter", () => {
  const total = F.counts(7, 3);
  const amount = F.counts(0, 0);
  const { usage, usageWindows, hasGap } = CodexUsage.resume().decodeBatch(F.entries(F.header(), F.report(total),
    F.report(total, amount, { request_id: "z1" }), F.report(total, amount, { request_id: "z2" }),
    F.report(total, amount, { request_id: "z1" }), F.report(total, F.counts(4, 1), { request_id: "stale" })));
  const calls = [...usage, ...usageWindows.flatMap(w => w.parts)].filter(p => p.kind === "call");
  assert.deepEqual(calls.map(p => [p.requestId, p.inputTokens, p.outputTokens]), [["z1", 0, 0], ["z2", 0, 0]]);
  assert.equal(hasGap, false);
});

test("copies at different physical paths share the native session origin and reproduce measurement IDs", () => {
  const entries = F.entries(F.header(), F.report(F.counts(9, 1), F.counts(4, 1)));
  const decode = (rows: typeof entries) => CodexUsage.resume().decodeBatch(rows).usageWindows;
  const expected = decode(entries);
  assert.equal(expected[0].historyId.startsWith("verified:"), true);
  const copy = entries.map(e => ({ ...e, sourceFile: "/different/installation/archived_sessions/copy.jsonl" }));
  copy[0].timestamp = F.later;
  assert.deepEqual(decode(copy), expected);
  const detailed = decode(F.entries(F.header(), F.report(F.counts(5, 0)), F.report(F.counts(9, 1), F.counts(4, 1))));
  assert.equal(detailed[1].historyId, expected[0].historyId);
  assert.equal(detailed[1].parts[0].id, expected[0].parts[0].id);
  const different = decode(F.entries(F.header({ timestamp: F.later }), F.report(F.counts(9, 1), F.counts(4, 1))));
  assert.notEqual(different[0].historyId, expected[0].historyId);
});

test("a partial file keeps the independently identified first call and uses the first total as its baseline", () => {
  for (const header of [
    F.header({ forked_from_id: "parent" }), F.header({ resumed_from: "prior" }),
    F.header({ source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } } }),
    F.header({ parent_session_id: "parent" }), F.header({ resume_from: "prior" }),
    F.header({ ordinal: 8 }), { ...F.header(), ordinal: 8 },
    F.header({ session_id: "disagrees" }), F.header({ resume: true }),
    F.header({ id: "other" }), { ...F.header({ timestamp: undefined }), timestamp: undefined },
  ]) {
    const entries = F.entries(header, F.report(F.counts(90, 20), F.counts(8, 2), { request_id: "one" }),
      F.report(F.counts(92, 21), F.counts(2, 1), { request_id: "two" }));
    const decoder = CodexUsage.resume();
    const start = decoder.decodeBatch(entries.slice(0, 2));
    assert.equal(start.hasGap, true);
    assert.deepEqual(start.usageWindows, []);
    assert.deepEqual(start.usage.map(p => [p.requestId, p.inputTokens, p.outputTokens]), [["one", 8, 2]]);
    const after = CodexUsage.resume(JSON.parse(JSON.stringify(decoder.snapshot()))).decodeBatch(entries.slice(2));
    assert.deepEqual(after.usageWindows[0].parts.map(p => [p.requestId, p.inputTokens, p.outputTokens]), [["two", 2, 1]]);
    assert.match(after.usageWindows[0].historyId, /^unverified:/);
    assert.deepEqual(start.usageAnchors, [{ historyId: after.usageWindows[0].historyId, usageId: start.usage[0].id }]);
  }
  const entries = F.entries(F.header(), F.report(F.counts(90, 20), F.counts(8, 2)));
  const afterPreamble = entries.map(e => ({ ...e, lineNumber: e.lineNumber + 1 }));
  const result = CodexUsage.resume().decodeBatch(afterPreamble);
  assert.equal(result.hasGap, true);
  assert.deepEqual([result.usage, result.usageWindows], [[], []]);
});

test("a last call in a different recorded turn is distinct from a pending request with the same amounts", () => {
  const amount = F.counts(4, 2);
  const { usageWindows } = CodexUsage.resume().decodeBatch(F.entries(F.header(),
    F.record("turn_context", { turn_id: "first", model: "model" }), F.report(undefined, amount, { request_id: "one" }),
    F.record("turn_context", { turn_id: "second", model: "model" }), F.report(F.counts(8, 4), amount)));
  assert.deepEqual(usageWindows[0].parts.map(p => [p.kind, p.turnId, p.requestId]),
    [["call", "first", "one"], ["call", "second", undefined]]);
});

test("a reset retains earlier request IDs and attributes later calls to a separate counter range", () => {
  const records = F.entries(
    F.header(), F.report(F.counts(100, 10), F.counts(20, 2), { request_id: "old" }),
    F.report(F.counts(4, 1), F.counts(4, 1), { request_id: "at-reset" }),
    F.report(undefined, F.counts(20, 2), { request_id: "old" }),
    F.report(F.counts(9, 3), F.counts(4, 1), { request_id: "at-reset" }),
  );
  const decoder = CodexUsage.resume();
  const start = decoder.decodeBatch(records.slice(0, 3));
  assert.equal(start.hasGap, true);
  assert.deepEqual(start.usage.map(p => p.requestId), ["at-reset"]);
  const fresh = CodexUsage.resume(JSON.parse(JSON.stringify(decoder.snapshot())));
  const after = fresh.decodeBatch(records.slice(3));
  assert.deepEqual(after.usage, []);
  assert.equal(after.usageWindows.length, 1);
  const [window] = after.usageWindows;
  assert.equal(window.historyId.startsWith(start.usageWindows[0].historyId + ":reset:"), true);
  assert.deepEqual(start.usageAnchors, [{ historyId: window.historyId, usageId: start.usage[0].id }]);
  assert.deepEqual(window.parts.map(p => [p.kind, p.inputTokens, p.outputTokens]), [["interval", 5, 2]]);
});

test("withholds an overlapping change, keeps native requests and counts growth after the new baseline", () => {
  const { usage, usageWindows, hasGap } = CodexUsage.resume().decodeBatch(F.entries(F.header(), F.report(F.counts(8, 2)),
    F.report(undefined, F.counts(5, 1), { request_id: "standalone" }),
    F.report(F.counts(10, 5), F.counts(4, 1), { request_id: "too-large" }),
    F.report(F.counts(13, 6)),
  ));
  assert.deepEqual(usage.map(p => [p.requestId, p.inputTokens, p.outputTokens]), [["standalone", 5, 1], ["too-large", 4, 1]]);
  assert.deepEqual(usageWindows.map(w => w.parts.map(p => [p.kind, p.inputTokens, p.outputTokens])),
    [[["interval", 8, 2]], [["interval", 3, 1]]]);
  assert.equal(hasGap, true);
});

test("keeps comparable optional counters on a repeated snapshot for the next measured change", () => {
  const { usageWindows, hasGap } = CodexUsage.resume().decodeBatch(F.entries(F.header(),
    F.report(F.counts(20, 8)), F.report(F.counts(20, 8, { cached_input_tokens: 15, reasoning_output_tokens: 4 })),
    F.report(F.counts(25, 12, { cached_input_tokens: 17, reasoning_output_tokens: 3 })),
    F.report(F.counts(30, 15, { cached_input_tokens: 18, reasoning_output_tokens: 4 })),
  ));
  assert.equal(hasGap, false);
  assert.deepEqual(usageWindows.flatMap(w => w.parts).map(p => [p.inputTokens, p.outputTokens, p.cacheReadTokens, p.reasoningTokens]),
    [[20, 8, undefined, undefined], [5, 4, 2, undefined], [5, 3, 1, 1]]);
});

test("malformed optional breakdowns never discard a reliable primary measurement", () => {
  const { usageWindows, hasGap } = CodexUsage.resume().decodeBatch(F.entries(F.header(),
    F.report(F.counts(20, 4, { cached_input_tokens: 19, cache_write_input_tokens: 2, reasoning_output_tokens: 2 })),
    F.report(F.counts(30, 9, { cached_input_tokens: "unknown", cache_write_input_tokens: 99, reasoning_output_tokens: 6 }),
      F.counts(5, 2, { cached_input_tokens: -1, reasoning_output_tokens: 1 })),
  ));
  assert.equal(hasGap, false);
  assert.deepEqual(usageWindows.flatMap(w => w.parts).map(p => [p.inputTokens, p.outputTokens, p.cacheReadTokens, p.cacheWriteTokens, p.reasoningTokens]),
    [[20, 4, undefined, undefined, 2], [5, 2, undefined, undefined, 1], [5, 3, undefined, undefined, 3]]);
});

test("a last-call cache or reasoning count exceeding the cumulative change leaves those subcounts unknown", () => {
  const { usageWindows, hasGap } = CodexUsage.resume().decodeBatch(F.entries(F.header(),
    F.report(F.counts(20, 8, { cached_input_tokens: 15, cache_write_input_tokens: 2, reasoning_output_tokens: 4 })),
    F.report(F.counts(40, 18, { cached_input_tokens: 20, cache_write_input_tokens: 5, reasoning_output_tokens: 7 }),
      F.counts(10, 5, { cached_input_tokens: 8, cache_write_input_tokens: 1, reasoning_output_tokens: 4 })),
  ));
  assert.equal(hasGap, false);
  const window = usageWindows[1];
  assert.deepEqual([window.start.cacheReadTokens, window.end.cacheReadTokens, window.start.reasoningTokens, window.end.reasoningTokens],
    [undefined, undefined, undefined, undefined]);
  assert.deepEqual(window.parts.map(p => [p.kind, p.inputTokens, p.outputTokens, p.cacheReadTokens, p.cacheWriteTokens, p.reasoningTokens]),
    [["call", 10, 5, undefined, 1, undefined], ["interval", 10, 5, undefined, 2, undefined]]);
});

test("conflicting subcounts at unchanged totals stay unknown through replay and restart", () => {
  const counters = (input: number, read: number) => F.report(F.counts(input, 5, { cached_input_tokens: read }));
  const entries = F.entries(F.header(), counters(12, 6), counters(12, 7), counters(12, 7), counters(15, 8));
  const first = CodexUsage.resume();
  first.decodeBatch(entries.slice(0, 3));
  const fresh = CodexUsage.resume(JSON.parse(JSON.stringify(first.snapshot())));
  const [window] = fresh.decodeBatch(entries.slice(3)).usageWindows;
  assert.deepEqual(window.parts.map(p => [p.inputTokens, p.outputTokens, p.cacheReadTokens]), [[3, 0, undefined]]);
});

test("subtracts the two primary fields independently up to the largest safe total", () => {
  const max = Number.MAX_SAFE_INTEGER;
  const { usageWindows, hasGap } = CodexUsage.resume().decodeBatch(F.entries(F.header(),
    F.report(F.counts(max - 20, 10)), F.report(F.counts(max - 18, 18), F.counts(1, 6))));
  assert.equal(hasGap, false);
  assert.deepEqual(usageWindows[1].parts.map(p => [p.kind, p.inputTokens, p.outputTokens]),
    [["call", 1, 6], ["interval", 1, 2]]);
});

test("an explicit provider call ID takes priority over a request from an earlier context record", () => {
  const { usage } = CodexUsage.resume().decodeBatch(F.entries(F.header(),
    F.record("turn_context", { turn_id: "turn", request_id: "first", model: "model" }),
    F.report(undefined, F.counts(4, 2), { call_id: "A" }), F.report(undefined, F.counts(4, 2), { call_id: "B" }),
  ));
  assert.equal(new Set(usage.map(p => p.id)).size, 2);
  assert.deepEqual(usage.map(p => p.requestId), [undefined, undefined]);
  assert.match(usage[0].id, /^call:native:[a-f0-9]{64}$/);
  const later = F.entries(F.header(), { ...F.report(undefined, F.counts(4, 2), { call_id: "A" }), timestamp: F.later });
  assert.equal(CodexUsage.resume().decodeBatch(later).usage[0].id, usage[0].id);
});

test("verbatim cumulative replays before and after a reset cannot charge the same deltas twice", () => {
  const first = F.report(F.counts(10, 2));
  const second = { ...F.report(F.counts(20, 3)), timestamp: F.later };
  const reset = { ...F.report(F.counts(4, 1)), timestamp: "2026-04-16T12:00:00Z" };
  const resumed = { ...F.report(F.counts(6, 2)), timestamp: "2026-04-16T12:01:00Z" };
  const entries = F.entries(F.header(), first, second, first, second, reset, resumed, first, second, reset, resumed);
  const parser = CodexUsage.resume();
  const original = parser.decodeBatch(entries.slice(0, 7));
  assert.equal(original.hasGap, true);
  assert.deepEqual(original.usageWindows.flatMap(w => w.parts).map(p => [p.inputTokens, p.outputTokens]), [[10, 2], [10, 1], [2, 1]]);
  const restored = CodexUsage.resume(JSON.parse(JSON.stringify(parser.snapshot())));
  assert.deepEqual(restored.decodeBatch(entries.slice(7)), { usage: [], usageWindows: [], hasGap: false });
});

test("both copies identify the same reset even when one missed the final pre-reset snapshot", () => {
  const first = F.report(F.counts(10, 2));
  const reset = { ...F.report(F.counts(4, 1)), timestamp: F.later };
  const after = F.report(F.counts(6, 3));
  const coarse = CodexUsage.resume().decodeBatch(F.entries(F.header(), first, reset, after)).usageWindows;
  const detailed = CodexUsage.resume().decodeBatch(F.entries(F.header(), first, F.report(F.counts(14, 4)), reset, after)).usageWindows;
  assert.deepEqual(coarse.at(-1), detailed.at(-1));
});

test("rejects incomplete, unsafe and inconsistent report totals, retaining a separately identified valid last call", () => {
  for (const invalid of [
    { input_tokens: 1 }, { output_tokens: 2 }, F.counts(-1, 3), F.counts(3.5, 1),
    F.counts(Number.MAX_SAFE_INTEGER, 1), F.counts(10, 1, { total_tokens: 9 }),
    F.counts(10, 1, { total_tokens: "11" }),
  ]) {
    const result = CodexUsage.resume().decodeBatch(F.entries(F.header(),
      F.report(invalid, F.counts(2, 1), { call_id: "provider-call" }), F.report(undefined, invalid)));
    assert.equal(result.hasGap, true);
    assert.deepEqual(result.usageWindows, []);
    assert.deepEqual(result.usage.map(p => [p.kind, p.inputTokens, p.outputTokens, p.requestId]), [["call", 2, 1, undefined]]);
  }
});

test("checkpoint state excludes raw transcript text and rejects malformed counters and pending call identities", () => {
  const entries = F.entries(F.header({ cwd: "/private/work" }), F.event("user_message", "Private text"),
    F.report(F.counts(3, 1)), F.report(undefined, F.counts(3, 1), { request_id: "r1" }));
  const decoder = CodexUsage.resume();
  decoder.decodeBatch(entries);
  const json = JSON.stringify(decoder.snapshot());
  assert.doesNotMatch(json, /Private text|private\/work/);
  const state = JSON.parse(json);
  for (const malformed of [null, [], {}, { ...state, baseline: { inputTokens: 1 } },
    { ...state, baseline: { inputTokens: 2, outputTokens: 1, reasoningTokens: 2 } },
    { ...state, historyId: "private" }, { ...state, pending: [{ ...state.pending[0], id: "malformed" }] },
    { ...state, seen: {} }, { ...state, observations: [] }, { ...state, observations: ["malformed"] },
    { ...state, observations: [state.observations[0], state.observations[0]] }, { ...state, unexpected: "private" }]) {
    assert.throws(() => CodexUsage.resume(malformed), { name: "Error", message: "Invalid chat parser state" });
  }
});
