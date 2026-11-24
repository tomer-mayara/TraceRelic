import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeSessionParser } from "#src/providers/claude/claude-session-parser";
import { ClaudeUsageFixture as F } from "../../../fixtures/claude-usage-fixture.ts";

const usage = { input_tokens: 20, output_tokens: 5 };

test("a remapped Claude row keeps the original transcript UUID, provider IDs and physical range", () => {
  const format = ClaudeSessionParser.forSource(false);
  const rows = F.positioned(
    F.row(F.advisorExample(), { content: "Copied answer" }, { uuid: "new", requestId: "remapped",
      forkedFrom: { sessionId: "parent", messageUuid: "original" } }),
    F.row(usage, { id: "new-message" }, { uuid: "own", requestId: "new-request" }),
  );
  const decoded = format.resume().decodeBatch(rows);
  const copied = { kind: "copy", parentSessionId: "parent", transcriptUuid: "new", parentMessageUuid: "original",
    sourceOrder: 8, byteRange: { startOffset: 23, endOffset: 100 } };
  assert.deepEqual(decoded.claudeUsageReports?.map(report => report.origin), [
    copied, copied, { kind: "own", transcriptUuid: "own", sourceOrder: 9, byteRange: { startOffset: 123, endOffset: 200 } },
  ]);
  assert.equal(decoded.claudeUsageReports?.[0].messageId, "msg");
  assert.equal(decoded.claudeUsageReports?.[0].requestId, "remapped");
  assert.equal(decoded.metadata.parentSessionId, "parent");
  assert.deepEqual(decoded.messages.map(({ id, text }) => [id, text]), [["native:new:0", "Copied answer"]]);
  assert.equal(format.checkpointFields?.claudeCallOrigins, true);
  const backfill = format.upgrade?.({ occurrences: {} });
  assert.deepEqual(backfill?.read(rows).claudeUsageReports, decoded.claudeUsageReports);
});

test("a Claude subagent reports independently identified work and preserves uncertain or marked copies", () => {
  const format = ClaudeSessionParser.forSource(false, { parentSessionId: "parent", agentId: "research" });
  const rows = F.positioned(...[
    { isSidechain: false, agentId: "research" }, {}, { agentId: "research" }, { isSidechain: true },
    { isSidechain: true, agentId: "research", forkedFrom: { sessionId: "parent", messageUuid: "p" } },
    { isSidechain: true, agentId: "another" },
  ].map(fields => F.row(usage, {}, fields)));
  const chat = format.resume().decodeBatch(rows);
  assert.equal(chat.metadata.parentSessionId, "parent");
  assert.deepEqual(chat.claudeUsageReports?.map(report => report.origin?.kind),
    ["subagent", "subagent", "own", "own", "copy", "subagent"]);
  assert(chat.claudeUsageReports?.every(report => report.origin?.parentSessionId === "parent"));
  assert.equal(chat.claudeUsageReports?.[4].origin?.parentMessageUuid, "p");
});

test("a Claude format corrects only an accepted checkpoint beyond byte zero that has no call origins", t => {
  const format = ClaudeSessionParser.forSource(false);
  assert.equal(format.correction?.({ offset: 10, parserState: "{}", claudeCallOrigins: true }), undefined);
  assert.equal(format.correction?.({ offset: 0, parserState: "{}" }), undefined);
  const checkpoint = { offset: 10, parserState: "{}" };
  const correction = format.correction?.(checkpoint);
  assert(correction);
  assert.equal(correction.parentSessionId, undefined);
  assert.deepEqual(correction.batchFields, { backfillClaudeOriginsFrom: checkpoint });
  assert.equal(correction.batchFields.backfillClaudeOriginsFrom, checkpoint);
  const reread = format.resume();
  const resume = t.mock.method(format, "resume");
  const decoder = { occurrences: { ["a".repeat(64)]: 1 } };
  assert.deepEqual(correction.accepted({ version: 2, decoder }, reread, format), { checkpoint: { ...checkpoint, claudeCallOrigins: true } });
  // The saved decoder is resumed even when the corrected checkpoint does not use it.
  assert.throws(() => correction.accepted({ version: 2, decoder: { unknown: 1 } }, reread, format), /Invalid chat parser state/);
  const fresh = correction.accepted(undefined, reread, format);
  assert("parser" in fresh);
  assert.equal(fresh.parser, reread);
  const earlier = correction.accepted({ version: 1, decoder }, reread, format);
  assert("parser" in earlier);
  assert.notEqual(earlier.parser, reread);
  assert.deepEqual(earlier.parser.snapshot(), decoder);
  // Each saved decoder is resumed through the format that the correction receives.
  assert.deepEqual(resume.mock.calls.map(call => call.arguments), [[decoder], [{ unknown: 1 }], [decoder]]);
  assert.equal(resume.mock.calls[2].result, earlier.parser);
  assert.deepEqual(ClaudeSessionParser.forSource(true).checkpointFields, { claudeCallOrigins: true });
});

test("a copied Claude user message establishes the parent even without a usage report", () => {
  const rows = F.positioned({ type: "user", timestamp: F.at, message: { role: "user", content: "Copied question" },
    uuid: "fresh", forkedFrom: { sessionId: "parent", messageUuid: "source" } });
  const chat = ClaudeSessionParser.forSource(false).resume().decodeBatch(rows);
  assert.deepEqual(chat.metadata, { parentSessionId: "parent" });
  assert.deepEqual(chat.messages.map(message => message.text), ["Copied question"]);
});

test("an incomplete fork marker keeps ownership uncertain without manufacturing a parent UUID", () => {
  const rows = F.positioned(...[{ sessionId: "parent" }, { messageUuid: "unscoped" }, false, null]
    .map(forkedFrom => F.row(usage, {}, { forkedFrom })));
  const { claudeUsageReports: reports } = ClaudeSessionParser.forSource(false).resume().decodeBatch(rows);
  assert.deepEqual(reports?.map(r => [r.origin?.kind, r.origin?.parentSessionId, r.origin?.parentMessageUuid]), [
    ["copy", "parent", undefined], ["copy", undefined, undefined], ["copy", undefined, undefined], ["own", undefined, undefined],
  ]);
});
