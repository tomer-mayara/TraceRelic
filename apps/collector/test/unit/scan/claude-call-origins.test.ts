import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeSessionParser } from "#src/scan/claude-session-parser";
import { ClaudeUsageFixture as F } from "../../fixtures/claude-usage-fixture.ts";

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
  assert.equal(format.claudeCallOrigins, true);
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
