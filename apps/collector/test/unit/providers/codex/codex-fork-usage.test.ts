import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { CodexChat } from "#src/providers/codex/codex-chat";
import { CodexSessionParser } from "#src/providers/codex/codex-session-parser";
import type { DecodedChat } from "#src/scan/decoded-chat";
import { CodexForkUsageFixture as F } from "../../../fixtures/codex-fork-usage-fixture.ts";

const forkFormat = (plan: typeof F.inherited | typeof F.uncertain) => CodexSessionParser.forFork(plan, F.forkedAt);

function measurements(result: DecodedChat) {
  return [...result.usage ?? [], ...(result.usageWindows ?? []).flatMap(window => window.parts)];
}

test("a fork skips copied usage, preserves copied text and resumes at the fork counter", () => {
  const format = forkFormat(F.inherited);
  const parser = format.resume();
  const lines = F.rows(F.child, F.event("user_message", "Inherited question"),
    F.report(F.counts(180, 20), F.counts(70, 10), { request_id: "copied" }), F.report(F.counts(200, 25)));
  const copy = parser.decodeBatch(lines.slice(0, 3));
  assert.deepEqual(measurements(copy), []);
  assert.deepEqual(copy.messages.map(message => message.text), ["Inherited question"]);
  assert.equal(copy.metadata.parentSessionId, "parent");
  assert.equal(copy.hasGap, false);
  const child = format.resume(JSON.parse(JSON.stringify(parser.snapshot()))).decodeBatch(lines.slice(3));
  assert.equal(child.hasGap, false);
  assert.deepEqual(measurements(child).map(row => [row.kind, row.inputTokens, row.outputTokens]), [["interval", 20, 5]]);
});

test("a verified fork starts a fresh counter from a measured first call or an explicit zero", () => {
  for (const first of [
    [F.report(F.counts(19, 6), F.counts(19, 6), { request_id: "first" })],
    [F.report(undefined, F.counts(19, 6), { request_id: "first" }),
      F.report(F.counts(19, 6), F.counts(19, 6), { request_id: "first" })],
    [F.report(F.counts(0, 0)), F.report(F.counts(19, 6))],
  ]) {
    const child = forkFormat(F.inherited).resume().decodeBatch(F.rows(F.child, F.header(), F.report(F.counts(180, 20)), ...first));
    assert.equal(child.hasGap, false);
    const known = new Map(measurements(child).map(row => [row.id, row]));
    assert.equal([...known.values()].reduce((sum, measurement) => sum + measurement.inputTokens + measurement.outputTokens, 0), 25);
  }
  const ambiguous = forkFormat(F.inherited).resume().decodeBatch(F.rows(F.child, F.header(), F.report(F.counts(180, 20)),
    F.report(F.counts(19, 6)), F.report(F.counts(20, 7))));
  assert.equal(ambiguous.hasGap, true);
  assert.deepEqual(measurements(ambiguous).map(call => [call.inputTokens, call.outputTokens]), [[1, 1]]);
});

test("a missing parent withholds disputed reports and keeps only calls tied to the child turn", () => {
  const format = forkFormat(F.uncertain);
  const parser = format.resume();
  const lines = F.rows(F.child, F.report(F.counts(180, 20), F.counts(70, 10), { request_id: "potential-copy" }),
    F.report(F.counts(196, 24)),
    F.record("event_msg", { type: "task_started", turn_id: "older", started_at: 1776265200 }),
    F.report(undefined, F.counts(2, 1), { request_id: "older", turn_id: "older" }),
    F.record("event_msg", { type: "task_started", turn_id: "ours", started_at: 1776265201 }),
    F.report(F.counts(200, 25), F.counts(4, 1), { request_id: "own", turn_id: "ours" }),
    F.report(undefined, F.counts(1, 1), { request_id: "other", turn_id: "foreign" }),
    F.record("event_msg", { type: "task_complete", turn_id: "ours" }),
    F.report(undefined, F.counts(2, 1), { request_id: "unattributed", turn_id: "ours" }));
  const before = parser.decodeBatch(lines.slice(0, 6));
  assert.deepEqual(measurements(before), []);
  assert.deepEqual(before.usageDiagnostics, [{ code: "unresolved-codex-fork", sourceOrder: 2 }]);
  assert.equal(before.hasGap, true);
  const tail = format.resume(JSON.parse(JSON.stringify(parser.snapshot()))).decodeBatch(lines.slice(6));
  assert.deepEqual(measurements(tail).map(row => [row.requestId, row.inputTokens, row.outputTokens]), [["own", 4, 1]]);
  assert.deepEqual(tail.usageWindows, []);
  const id = createHash("sha256").update(JSON.stringify(["request", "own"])).digest("hex");
  assert.deepEqual(tail.codexCallClaims, [{ providerId: id, usageId: measurements(tail)[0].id, ownerSessionId: "planning" }]);
});

test("native item ownership can identify a child turn with an unavailable parent", () => {
  const result = forkFormat(F.uncertain).resume().decodeBatch(F.rows(F.child,
    F.report(F.counts(100, 0)), F.record("event_msg", { type: "item_completed", thread_id: "planning", turn_id: "a" }),
    F.report(undefined, F.counts(5, 0), { call_id: "own" }),
    F.record("event_msg", { type: "item_completed", thread_id: "parent", turn_id: "b" }),
    F.report(undefined, F.counts(7, 0), { call_id: "parent", turn_id: "b" })));
  assert.deepEqual(measurements(result).map(call => call.inputTokens), [5]);
});

test("a native call carries a workspace provider key and keeps its session-scoped usage ID", () => {
  const report = F.report(F.counts(4, 1), F.counts(4, 1), { call_id: "provider-call" });
  const source = F.rows(F.header(), report);
  const first = CodexSessionParser.resume().decodeBatch(source);
  const other = CodexSessionParser.resume().decodeBatch(F.rows(F.header({ id: "another" }), report)
    .map(entry => ({ ...entry, sessionId: "another" })));
  const digest = createHash("sha256").update(JSON.stringify(["call", "provider-call"])).digest("hex");
  assert.deepEqual(first.codexCallClaims, [{ providerId: digest, usageId: measurements(first)[0].id, ownerSessionId: "planning" }]);
  assert.deepEqual(other.codexCallClaims, [{ providerId: digest, usageId: measurements(other)[0].id, ownerSessionId: "another" }]);
  assert.notEqual(measurements(first)[0].id, measurements(other)[0].id);
});

test("a text-only checkpoint backfills child usage while preserving accepted chat state", () => {
  const format = forkFormat(F.inherited);
  assert(format.upgrade);
  const rows = F.rows(F.child, F.event("user_message", "A question"), F.report(F.counts(180, 20)),
    F.report(F.counts(190, 25)), F.report(F.counts(193, 27)));
  const chat = CodexChat.resume();
  chat.decodeBatch(rows.slice(0, 4));
  const previous = JSON.parse(JSON.stringify(chat.snapshot()));
  const upgrade = format.upgrade(previous);
  const backfill = upgrade.read(rows.slice(0, 4));
  assert.deepEqual(backfill.usageWindows?.flatMap(window => window.parts.map(row => [row.inputTokens, row.outputTokens])), [[10, 5]]);
  assert.deepEqual(JSON.parse(JSON.stringify(upgrade.parser.snapshot())).chat, previous);
  const resumed = format.resume(JSON.parse(JSON.stringify(upgrade.parser.snapshot())));
  assert.deepEqual(measurements(resumed.decodeBatch(rows.slice(4))).map(row => [row.inputTokens, row.outputTokens]), [[3, 2]]);
});
