import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeUsage } from "#src/scan/claude-usage";
import { ClaudeUsageFixture as F } from "../../fixtures/claude-usage-fixture.ts";

test("emits whole assistant reports for text and tool-only rows with their native identity", () => {
  const input = { input_tokens: 10, cache_read_input_tokens: 25, cache_creation_input_tokens: 5 };
  const early = F.row({ ...input, output_tokens: 2 }, { content: "Plan", stop_reason: null });
  const final = F.row({ ...input, output_tokens: 91 }, { content: [{ type: "tool_use" }], stop_reason: "tool_use" });
  const fields = {
    messageId: "msg", requestId: "req", model: "executor", turnId: "turn", at: F.at,
    inputTokens: 40, cacheReadTokens: 25, cacheWriteTokens: 5,
  };
  const first = { ...fields, outputTokens: 2, status: "provisional" };
  const last = { ...fields, outputTokens: 91, status: "final" };
  assert.deepEqual(ClaudeUsage.decodeBatch(F.entries(early, final)), {
    claudeUsageReports: [first, last], usageDiagnostics: [], hasGap: false,
  });
  assert.deepEqual(ClaudeUsage.decodeBatch(F.entries(final, early)).claudeUsageReports, [last, first]);
});

test("an explicit zero is a complete measurement, while absent cache fields stay unknown", () => {
  const rows = F.entries(
    F.row({ input_tokens: 0, output_tokens: 0 }, { id: undefined, model: undefined }),
    F.row({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      { stop_reason: "end_turn" }, { requestId: undefined }),
    F.row({ input_tokens: 1, output_tokens: 1, cache_creation: null, cache_read_input_tokens: null }),
  );
  const result = ClaudeUsage.decodeBatch(rows);
  assert.equal(result.hasGap, false);
  assert.deepEqual(result.usageDiagnostics, []);
  const [first, second, third] = result.claudeUsageReports;
  assert.deepEqual(first, { requestId: "req", turnId: "turn", at: F.at, status: "provisional", inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(second, {
    messageId: "msg", turnId: "turn", model: "executor", at: F.at, status: "final",
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  });
  assert.equal(third.inputTokens, 1);
  assert.equal(third.cacheReadTokens, undefined);
});

test("skips synthetic and non-assistant rows even when they copy valid usage", () => {
  const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 };
  const rows = F.entries(
    F.row(usage, { model: "<synthetic>" }), F.row(usage, {}, { isMeta: true }),
    F.row(usage, {}, { isCompactSummary: true }), F.row(usage, { role: "user" }),
    F.row(usage, { role: "user", content: [{ type: "tool_result" }] }, { type: "user" }),
    F.row(undefined), F.row(null), F.row({}),
  );
  assert.deepEqual(ClaudeUsage.decodeBatch(rows), { claudeUsageReports: [], usageDiagnostics: [], hasGap: false });
});

test("a row UUID cannot identify a model call and a usage time must be recorded", () => {
  const usage = { input_tokens: 1, output_tokens: 2 };
  const result = ClaudeUsage.decodeBatch(F.entries(
    F.row(usage, { id: undefined }, { requestId: undefined, uuid: "row-id" }),
    F.row(usage, {}, { timestamp: undefined }), F.row(usage, {}, { timestamp: "2026-02-31" }),
  ));
  assert.deepEqual(result, {
    claudeUsageReports: [], hasGap: true, usageDiagnostics: [
      { code: "unidentified-claude-call", sourceOrder: 1 },
      { code: "invalid-claude-usage", sourceOrder: 2 }, { code: "invalid-claude-usage", sourceOrder: 3 },
    ],
  });
});

test("rejects incomplete, negative and unsafe primary counts and unsafe sums", () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  const invalid = [
    { output_tokens: 2 }, { input_tokens: 2 }, { input_tokens: -1, output_tokens: 2 },
    { input_tokens: 0, output_tokens: 1.5 }, { input_tokens: maximum, output_tokens: 1 },
    { input_tokens: maximum, cache_creation_input_tokens: 1, output_tokens: 0 },
    { input_tokens: 5, cache_read_input_tokens: "2", output_tokens: 1 }, "unsupported",
  ];
  for (const usage of invalid) {
    assert.deepEqual(ClaudeUsage.decodeBatch(F.entries(F.row(usage))), {
      claudeUsageReports: [], usageDiagnostics: [{ code: "invalid-claude-usage", sourceOrder: 1 }], hasGap: true,
    });
  }
});

test("cache durations partition flat writes and supply their total when the flat count is absent", () => {
  const usage = {
    input_tokens: 10, cache_read_input_tokens: 25, output_tokens: 1,
    cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 },
  };
  const result = ClaudeUsage.decodeBatch(F.entries(F.row(usage), F.row({ ...usage, cache_creation_input_tokens: 5 })));
  assert.deepEqual(result.usageDiagnostics, []);
  assert.equal(result.hasGap, false);
  assert.equal(result.claudeUsageReports.length, 2);
  for (const row of result.claudeUsageReports) {
    assert.deepEqual([row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheWriteTokens,
      row.cacheWrite5mTokens, row.cacheWrite1hTokens], [40, 1, 25, 5, 2, 3]);
  }
});

test("an incomplete or unknown duration breakdown needs a flat count to measure inclusive input", () => {
  for (const breakdown of [
    { ephemeral_5m_input_tokens: 2 }, { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: -1 },
    { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 1, future_input_tokens: 2 }, {},
    { ephemeral_5m_input_tokens: Number.MAX_SAFE_INTEGER, ephemeral_1h_input_tokens: 1 }, "unsupported",
  ]) {
    const usage = { input_tokens: 10, output_tokens: 1, cache_creation: breakdown };
    const diagnostic = [{ code: "unsupported-claude-cache-breakdown", sourceOrder: 1 }];
    assert.deepEqual(ClaudeUsage.decodeBatch(F.entries(F.row(usage))), {
      claudeUsageReports: [], usageDiagnostics: diagnostic, hasGap: true,
    });
    const measured = ClaudeUsage.decodeBatch(F.entries(F.row({ ...usage, cache_creation_input_tokens: 5 })));
    assert.deepEqual(measured.usageDiagnostics, diagnostic);
    assert.equal(measured.hasGap, false);
    assert.equal(measured.claudeUsageReports[0].inputTokens, 15);
    assert.equal(measured.claudeUsageReports[0].cacheWriteTokens, 5);
  }
});

test("a flat counter preserves reliable input when a reported duration partition disagrees", () => {
  const usage = { input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 1 };
  const result = ClaudeUsage.decodeBatch(F.entries(
    F.row({ ...usage, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 4 } }),
    F.row({ ...usage, cache_creation: { ephemeral_5m_input_tokens: 2 } }),
  ));
  assert.equal(result.hasGap, false);
  const [conflicting, incomplete] = result.claudeUsageReports;
  assert.deepEqual([conflicting.inputTokens, conflicting.cacheWriteTokens, conflicting.cacheWrite5mTokens,
    conflicting.cacheWrite1hTokens], [15, 5, undefined, undefined]);
  assert.deepEqual([incomplete.inputTokens, incomplete.cacheWrite5mTokens, incomplete.cacheWrite1hTokens], [15, 2, undefined]);
  assert.deepEqual(result.usageDiagnostics, [
    { code: "unsupported-claude-cache-breakdown", sourceOrder: 1 },
    { code: "unsupported-claude-cache-breakdown", sourceOrder: 2 },
  ]);
});

test("the provider advisor example charges each advisor separately from the top-level executor total", () => {
  const entries = F.entries(F.row(F.advisorExample(), { stop_reason: "end_turn" }));
  const result = ClaudeUsage.decodeBatch(entries);
  assert.deepEqual(result.usageDiagnostics, []);
  assert.equal(result.hasGap, false);
  const { claudeUsageReports: reports } = result;
  assert.deepEqual(reports.map(row => [row.model, row.messageId, row.requestId, row.status, row.inputTokens, row.outputTokens]), [
    ["executor", "msg", "req", "final", 2172, 531], ["claude-opus-5-5", "msg", "req", "final", 823, 1612],
  ]);
  assert.equal(reports[0].iterationId, undefined);
  assert.ok(reports[1].iterationId);
  assert.deepEqual(ClaudeUsage.decodeBatch(entries), result);
});

test("an advisor keeps its provider ID across copies and fallback positions distinguish equal iterations", () => {
  const usage = F.advisorExample();
  const advisor = { ...usage.iterations[1], model: undefined };
  const identified = { ...advisor, id: "1" };
  const scan = (iterations: unknown[]) => ClaudeUsage.decodeBatch(F.entries(F.row({ ...usage, iterations }))).claudeUsageReports.slice(1);
  const first = scan([identified, advisor, advisor]);
  assert.equal(first.length, 3);
  assert.equal(new Set(first.map(row => row.iterationId)).size, 3);
  assert.ok(first.every(row => row.iterationId && row.model === undefined));
  const copy = scan([usage.iterations[0], identified]);
  assert.equal(copy[0].iterationId, first[0].iterationId);
});

test("unsupported iteration data reports a gap and keeps independently measured calls", () => {
  const usage = F.advisorExample();
  const valid = usage.iterations[1];
  const unsupported = { type: "future_message", input_tokens: 100, output_tokens: 100 };
  const results = ClaudeUsage.decodeBatch(F.entries(
    F.row({ ...usage, iterations: [unsupported, null, valid, unsupported] }),
    F.row({ ...usage, iterations: {} }),
    F.row({ ...usage, input_tokens: -1, iterations: [valid] }),
    F.row({ ...usage, iterations: [{ ...valid, output_tokens: -1 }] }),
  ));
  assert.deepEqual(results.claudeUsageReports.map(row => row.model), ["executor", "claude-opus-5-5", "executor", "claude-opus-5-5", "executor"]);
  assert.deepEqual(results.usageDiagnostics, [
    { code: "unsupported-claude-iteration", sourceOrder: 1 }, { code: "unsupported-claude-iteration", sourceOrder: 2 },
    { code: "invalid-claude-usage", sourceOrder: 3 }, { code: "invalid-claude-usage", sourceOrder: 4 },
  ]);
  assert.equal(results.hasGap, true);
});
