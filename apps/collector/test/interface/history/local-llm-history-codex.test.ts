import assert from "node:assert/strict";
import { appendFile, copyFile, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { GlobalConfig } from "@tracerelic/collector/config";
import { LocalLLMHistoryCodex, type LocalLLMHistory } from "@tracerelic/collector/history";
import { CodexRolloutFixture as Rollout } from "../../fixtures/codex-rollout-fixture.ts";

const start = new Date("2026-02-01T00:00:00Z");
const end = new Date("2026-02-02T00:00:00Z");

test("reads the original Codex message with its session and source position", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const message = Rollout.message("2026-02-01T09:30:00-05:00", "Plan search");
  const sourceFile = await fixture.write([Rollout.header("c1"), message]);
  const reader: LocalLLMHistory = new LocalLLMHistoryCodex(new GlobalConfig(fixture.home));
  assert.deepEqual(await reader.readLocalHistory(start, end), [{
    harness: "codex", sessionId: "c1", sourceFile, lineNumber: 2, timestamp: message.timestamp, record: message,
  }]);
});

for (const archived of [false, true]) {
  test(`filters the ${archived ? "archived" : "active"} January rollout by record time`, async t => {
    const fixture = await Rollout.create();
    t.after(() => fixture.close());
    const header = { ...Rollout.header("c1"), payload: { session_id: "c1" } };
    const messages = [
      Rollout.message("2026-01-31T23:59:59.999Z", "Earlier"),
      Rollout.message("2026-01-31T19:00:00.000-05:00", "Plan search"),
      Rollout.message("2026-02-01T12:00:00.000Z", "Use an index"),
      Rollout.message("2026-02-02T00:00:00.000Z", "Next day"),
    ];
    const sourceFile = await fixture.write([header, ...messages], archived);
    const lastModified = new Date("2026-03-01T00:00:00Z");
    await utimes(sourceFile, lastModified, lastModified);
    const reader: LocalLLMHistory = new LocalLLMHistoryCodex(new GlobalConfig(fixture.home));
    assert.deepEqual(await reader.readLocalHistory(start, end), messages.slice(1, 3).map((record, index) => ({
      harness: "codex", sessionId: "c1", sourceFile, lineNumber: index + 3, timestamp: record.timestamp, record,
    })));
  });
}

test("reads each rollout under the provider home and labels it with its own session", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const header = { ...Rollout.header("active"), timestamp: start.toISOString() };
  const active = await fixture.write([header]);
  const context = Rollout.turnContext(start.toISOString(), "turn-7");
  const archived = await fixture.write([Rollout.header("archived"), context], true);
  await copyFile(active, join(dirname(active), "history.jsonl"));
  await copyFile(archived, join(fixture.home, "rollout-unselected.jsonl"));

  const reader: LocalLLMHistory = new LocalLLMHistoryCodex(new GlobalConfig(fixture.home));
  const entries = await reader.readLocalHistory(start, end);
  assert.deepEqual([...entries].sort((a, b) => a.sessionId.localeCompare(b.sessionId)), [
    { harness: "codex", sessionId: "active", sourceFile: active, lineNumber: 1, timestamp: header.timestamp, record: header },
    { harness: "codex", sessionId: "archived", sourceFile: archived, lineNumber: 2, timestamp: context.timestamp, record: context },
  ]);
});

test("preserves the original token_count fields and file order across a clock change", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const message = Rollout.message("2026-02-01T12:00:00Z", "A message");
  const usage = Rollout.tokenCount("2026-02-01T11:59:59Z");
  const sourceFile = await fixture.write([Rollout.header("c1"), message, usage]);
  const reader: LocalLLMHistory = new LocalLLMHistoryCodex(new GlobalConfig(fixture.home));
  assert.deepEqual(await reader.readLocalHistory(start, end), [message, usage].map((record, index) => ({
    harness: "codex", sessionId: "c1", sourceFile, lineNumber: index + 2, timestamp: record.timestamp, record,
  })));
});

test("reads multibyte text across chunks and leaves an unfinished last line for a later call", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const header = Rollout.header("c1");
  const message = Rollout.message("2026-02-01T01:02:03Z", "");
  const block = message.payload.content[0];
  // Place the first byte of the four-byte character at the end of a 64 KiB chunk.
  const prefix = JSON.stringify(header).length + 1 + JSON.stringify(message).indexOf('"text":""') + '"text":"'.length;
  block.text = "x".repeat(65535 - prefix) + "🌱";
  const tail = Rollout.message("2026-02-01T02:03:04Z", "Still writing");
  const sourceFile = await fixture.write([header, message]);
  await appendFile(sourceFile, JSON.stringify(tail));
  const reader: LocalLLMHistory = new LocalLLMHistoryCodex(new GlobalConfig(fixture.home));
  assert.deepEqual((await reader.readLocalHistory(start, end)).map(entry => entry.record), [message]);
  await appendFile(sourceFile, "\n");
  assert.deepEqual((await reader.readLocalHistory(start, end)).map(entry => entry.record), [message, tail]);
});

test("only returns records with a valid timestamp and UTC offset", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const malformed = [
    "2026-01-32T12:00:00Z", "2026-02-01", "2026-02-01T12:00:00",
    "2026-01-31T24:00:00Z", "2026-02-30T12:00:00Z", "2026-02-01T12:00:00+0100",
  ];
  await fixture.write([Rollout.header("c1"), ...malformed.map(at => Rollout.message(at, "Malformed timestamp"))]);
  const reader: LocalLLMHistory = new LocalLLMHistoryCodex(new GlobalConfig(fixture.home));
  assert.deepEqual(await reader.readLocalHistory(start, new Date("2026-03-04T00:00:00Z")), []);
});

test("includes a leap second in the window ending at UTC midnight", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const header = { ...Rollout.header("c1"), timestamp: "2016-12-31T23:58:00Z" };
  const message = Rollout.message("2017-01-01T00:59:60.125+01:00", "Before midnight UTC");
  await fixture.write([header, message]);
  const reader: LocalLLMHistory = new LocalLLMHistoryCodex(new GlobalConfig(fixture.home));
  const midnight = new Date("2017-01-01T00:00:00Z");
  const entries = await reader.readLocalHistory(new Date(midnight.getTime() - 1), midnight);
  assert.deepEqual(entries.map(entry => entry.record), [message]);
  assert.deepEqual(await reader.readLocalHistory(midnight, new Date(midnight.getTime() + 1)), []);
});

test("rejects invalid or reversed date windows", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const reader: LocalLLMHistory = new LocalLLMHistoryCodex(new GlobalConfig(fixture.home));
  const invalid = new Date(NaN);
  await assert.rejects(reader.readLocalHistory(invalid, end), RangeError);
  await assert.rejects(reader.readLocalHistory(start, invalid), RangeError);
  await assert.rejects(reader.readLocalHistory(end, start), RangeError);
});

test("reports a filesystem error when a regular file is configured as the root", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const file = await fixture.write([Rollout.header("c1")]);
  const reader: LocalLLMHistory = new LocalLLMHistoryCodex(new GlobalConfig(file));
  await assert.rejects(reader.readLocalHistory(start, end), { code: "ENOTDIR" });
});

test("keeps the rollout session ID when it contains an older copied header", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const message = Rollout.message("2026-02-01T08:00:00Z", "Continue");
  const sourceFile = await fixture.write([Rollout.header(""), Rollout.header("c1"), Rollout.header("older-session"), message]);
  const reader: LocalLLMHistory = new LocalLLMHistoryCodex(new GlobalConfig(fixture.home));
  assert.deepEqual(await reader.readLocalHistory(start, end), [{
    harness: "codex", sessionId: "c1", sourceFile, lineNumber: 4, timestamp: message.timestamp, record: message,
  }]);
});

test("skips a damaged UTF-8 record and preserves the next record's line number", async t => {
  const fixture = await Rollout.create();
  t.after(() => fixture.close());
  const sourceFile = await fixture.write([Rollout.header("c1")]);
  const message = Rollout.message("2026-02-01T08:00:00Z", "Original text");
  const damaged = Buffer.from(JSON.stringify(message) + "\n");
  damaged[damaged.indexOf("Original text")] = 0xff;
  await appendFile(sourceFile, damaged);
  await appendFile(sourceFile, JSON.stringify(message) + "\n");

  const reader: LocalLLMHistory = new LocalLLMHistoryCodex(new GlobalConfig(fixture.home));
  assert.deepEqual(await reader.readLocalHistory(start, end), [{
    harness: "codex", sessionId: "c1", sourceFile, lineNumber: 3, timestamp: message.timestamp, record: message,
  }]);
});
