import assert from "node:assert/strict";
import { test } from "node:test";
import { ReplayOccurrences } from "#src/scan/replay-occurrences";
import { ReplayOccurrencesFixture as F } from "../../fixtures/replay-occurrences-fixture.ts";

test("counts occurrences across batches and keeps native IDs and separate blocks intact", () => {
  const first = F.message(F.unique, 1, 2, 0);
  const otherBlock = F.message(F.unique, 1, 2, 3);
  const native = { ...first, id: "native:request:0" };
  const added = F.message(F.added, 1, 4);
  const counts = new Map<string, number>();
  ReplayOccurrences.count(counts, [first, otherBlock]);
  ReplayOccurrences.count(counts, [native, added]);
  assert.deepEqual(counts, new Map([[F.unique, 1], [F.added, 1]]));
  const rules = ReplayOccurrences.plan([first, otherBlock, native], counts);
  const chat = F.chat(first, otherBlock, native, added);
  ReplayOccurrences.reconcile(chat, rules);
  assert.deepEqual(chat, F.chat(first, otherBlock, native, added));
});

test("losing one identical row preserves both accepted IDs and reserves the next ordinal for an append", () => {
  const first = F.message(F.repeated, 1, 2);
  const second = F.message(F.repeated, 2, 3);
  const next = F.message(F.repeated, 1, 5);
  const counts = new Map<string, number>();
  ReplayOccurrences.count(counts, [next]);
  const rules = ReplayOccurrences.plan([first, second], counts);
  assert.deepEqual(rules, { [F.repeated]: { accepted: 2, replayed: 1 } });
  const chat = F.chat(next, { ...next, blockIndex: 2, id: `text:${F.repeated}:1:2` });
  ReplayOccurrences.reconcile(chat, rules);
  assert.deepEqual(chat.messages, []);
  assert.equal(chat.hasGap, true);
  assert.deepEqual(chat.usageDiagnostics, [{ code: "ambiguous-transcript-replay", sourceOrder: 5 }]);
  const saved = ReplayOccurrences.restore(JSON.parse(JSON.stringify(rules)));
  assert(saved);
  const appended = F.chat(F.message(F.repeated, 2, 6, 0), F.message(F.repeated, 2, 6, 2));
  ReplayOccurrences.reconcile(appended, saved);
  assert.deepEqual(appended, F.chat(F.message(F.repeated, 3, 6, 0), F.message(F.repeated, 3, 6, 2)));
});

test("new copies of an old unidentified row after a rewrite cannot be assigned by position", () => {
  const first = F.message(F.repeated, 1, 2);
  const second = F.message(F.repeated, 2, 3);
  const rules = ReplayOccurrences.plan([first], new Map([[F.repeated, 2]]));
  const chat = F.chat(first, second);
  ReplayOccurrences.reconcile(chat, rules);
  assert.deepEqual(chat.messages, []);
  assert.deepEqual(chat.usageDiagnostics, [
    { code: "ambiguous-transcript-replay", sourceOrder: 2 },
    { code: "ambiguous-transcript-replay", sourceOrder: 3 },
  ]);
  const appended = F.chat(F.message(F.repeated, 3, 4));
  ReplayOccurrences.reconcile(appended, rules);
  assert.deepEqual(appended, F.chat(F.message(F.repeated, 2, 4)));
});

test("a completely removed group leaves its old IDs reserved without a disputed replacement line", () => {
  const prior = F.message(F.repeated, 1, 2);
  const rules = ReplayOccurrences.plan([prior], new Map());
  const chat = F.chat(F.message(F.repeated, 1, 4));
  ReplayOccurrences.reconcile(chat, rules);
  assert.deepEqual(chat, F.chat(F.message(F.repeated, 2, 4)));
});

test("rejects invalid saved occurrence ranges without exposing checkpoint contents", () => {
  const valid = { accepted: 2, replayed: 1 };
  assert.equal(ReplayOccurrences.restore(undefined), undefined);
  for (const value of [
    null, [], "private", { private: valid }, { [F.repeated]: { ...valid, accepted: -1 } },
    { [F.repeated]: { ...valid, accepted: 1.5 } },
    { [F.repeated]: { ...valid, replayed: Number.MAX_SAFE_INTEGER + 1 } },
    { [F.repeated]: { ...valid, replayed: 0.1 } }, { [F.repeated]: { ...valid, private: true } },
  ]) {
    assert.throws(() => ReplayOccurrences.restore(value), { message: "Invalid chat parser state" });
  }
});
