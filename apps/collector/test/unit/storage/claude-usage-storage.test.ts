import assert from "node:assert/strict";
import { test } from "node:test";
import type { Batch, Usage, UsageDiagnostic } from "@tracerelic/collector/storage";
import {
  batch, claudeParserState, claudeReport, codexParserState, codexSource, planning, request, source,
} from "../../fixtures/collector-storage-fixture.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";

test("a stale Claude writer cannot replace accepted evidence and an older replay preserves the correction", async () => {
  const store = new InMemoryCollectorStorage();
  const copy = { ...source, installationId: "second" };
  const tentative = claudeReport();
  const first = batch(0, 0, { messages: [planning], claudeUsageReports: [tentative] });
  assert.equal(await store.commit(first), "committed");
  const original = await store.readSession(source);
  assert.equal(original?.observedTotalTokens, 42);
  const [call] = original.usage;
  const final = claudeReport({ status: "final", outputTokens: 91, at: "2026-01-01T00:00:01Z" });
  const correction = batch(0, 0, { source: copy, claudeUsageReports: [final] });
  assert.equal(await store.commit(correction), "conflict");
  assert.deepEqual(await store.readSession(source), original);
  assert.deepEqual(await store.readCheckpoint(copy), { version: 1, checkpoint: null });
  assert.equal(await store.commit({ ...correction, expectedVersion: 1 }), "committed");
  const corrected = await store.readSession(source);
  assert.equal(corrected?.observedTotalTokens, 131);
  assert.deepEqual(corrected.usage, [{ ...call, status: "final", revision: call.revision + 1, outputTokens: 91 }]);
  assert.deepEqual(corrected.messages, [planning]);
  assert.equal(await store.commit(batch(2, 10, { claudeUsageReports: [tentative, final] })), "committed");
  assert.deepEqual(await store.readSession(copy), corrected);
});

test("disputed calls leave the total and return to their original position when resolved", async () => {
  const store = new InMemoryCollectorStorage();
  const original = claudeReport();
  const independent = claudeReport({ messageId: "other", requestId: "other-request" });
  assert.equal(await store.commit(batch(0, 0, { claudeUsageReports: [original, independent] })), "committed");
  const first = await store.readSession(source);
  assert.equal(first?.observedTotalTokens, 84);
  const disputed = claudeReport({ inputTokens: 39, outputTokens: 10 });
  assert.equal(await store.commit(batch(1, 10, { claudeUsageReports: [disputed, original] })), "committed");
  const partial = await store.readSession(source);
  assert.deepEqual(partial?.usage, [first.usage[1]]);
  assert.equal(partial.observedTotalTokens, 42);
  assert.equal(partial.coverage, "partial");
  assert.equal(await store.commit(batch(2, 20, { claudeUsageReports: [claudeReport({ status: "final" })] })), "committed");
  const restored = await store.readSession(source);
  assert.equal(restored?.observedTotalTokens, 84);
  assert.deepEqual(restored.usage.map(u => u.id), first.usage.map(u => u.id));
  assert.equal(restored.coverage, "partial");
});

test("diagnostics are unique per installation, stream, line and code", async () => {
  const store = new InMemoryCollectorStorage();
  const diagnostic: UsageDiagnostic = { code: "unsupported-claude-iteration", sourceOrder: 6 };
  const other: UsageDiagnostic = { code: "invalid-claude-usage", sourceOrder: 6 };
  const local = { ...source, installationId: "one" };
  const remote = { ...source, installationId: "two" };
  assert.equal(await store.commit(batch(0, 0, {
    source: local, usageDiagnostics: [diagnostic, other, diagnostic], claudeUsageReports: [claudeReport()], hasGap: true,
  })), "committed");
  assert.equal(await store.commit(batch(1, 10, { source: local, usageDiagnostics: [diagnostic] })), "committed");
  assert.equal(await store.commit(batch(2, 0, { source: remote, usageDiagnostics: [diagnostic] })), "committed");
  const view = await store.readSession(source);
  assert.equal(view?.coverage, "partial");
  assert.deepEqual(view.usageDiagnostics, [
    { ...diagnostic, streamId: source.streamId, installationId: "one" },
    { ...other, streamId: source.streamId, installationId: "one" },
    { ...diagnostic, streamId: source.streamId, installationId: "two" },
  ]);
});

for (const together of [false, true]) {
  test(`a Claude call disputed in ${together ? "its first" : "a later"} batch keeps its place across a directly versioned record`, async () => {
    const store = new InMemoryCollectorStorage();
    const append = async (fields: Partial<Batch>) => {
      const { checkpoint, version } = await store.readCheckpoint(source);
      assert.equal(await store.commit(batch(version, checkpoint?.offset ?? 0, fields)), "committed");
    };
    const other = claudeReport({ messageId: "second", requestId: "second" });
    const dispute = claudeReport({ inputTokens: 39, outputTokens: 3 });
    await append({ claudeUsageReports: together ? [claudeReport(), dispute, other] : [claudeReport(), other] });
    if (!together) await append({ claudeUsageReports: [dispute] });
    await append({ usage: [request({ id: "direct" })] });
    await append({ claudeUsageReports: [claudeReport({ status: "final" })] });
    const restored = await store.readSession(source);
    assert.deepEqual(restored?.usage.map(record => record.requestId ?? record.id), ["request", "second", "direct"]);
  });
}

test("a directly versioned replay cannot restore a disputed native measurement", async () => {
  const store = new InMemoryCollectorStorage();
  const measured = claudeReport();
  assert.equal(await store.commit(batch(0, 0, { claudeUsageReports: [measured] })), "committed");
  const published = await store.readSession(source);
  assert(published);
  const dispute = batch(1, 10, { claudeUsageReports: [claudeReport({ inputTokens: 39, outputTokens: 3 })] });
  assert.equal(await store.commit(dispute), "committed");
  const withheld = await store.readSession(source);
  assert.equal(withheld?.observedTotalTokens, null);
  assert.equal(await store.commit(batch(2, 20, { usage: published.usage, messages: [planning] })), "invalid");
  assert.deepEqual(await store.readSession(source), withheld);
  assert.deepEqual(await store.readCheckpoint(source), { version: 2, checkpoint: dispute.checkpoint });
});

test("malformed, foreign or overflowing Claude evidence rolls back every part of the batch", async () => {
  const store = new InMemoryCollectorStorage();
  const first = batch(0, 0, { claudeUsageReports: [claudeReport()] });
  assert.equal(await store.commit(first), "committed");
  const before = await store.readSession(source);
  const write = batch(1, 10, { messages: [planning], metadata: { cwd: "/uncommitted" }, hasGap: true });
  for (const fields of [
    { claudeUsageReports: null }, { claudeUsageReports: {} }, { claudeUsageReports: [null] },
    { claudeUsageReports: [claudeReport({ requestId: undefined, messageId: undefined })] },
    { claudeUsageReports: [{ ...claudeReport(), status: "maybe" }] }, { claudeUsageReports: [claudeReport({ at: "yesterday" })] },
    { claudeUsageReports: [claudeReport({ inputTokens: 1, cacheReadTokens: 3 })] },
    { claudeUsageReports: [claudeReport({ cacheWriteTokens: undefined, cacheWrite5mTokens: 4 })] },
    { claudeUsageReports: [claudeReport({ cacheWrite5mTokens: 6 })] },
    { claudeUsageReports: [claudeReport({ cacheWrite5mTokens: 1, cacheWrite1hTokens: 2 })] },
    { claudeUsageReports: [claudeReport({ requestId: "huge", messageId: "huge", inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 })] },
    { usageDiagnostics: [null] }, { usageDiagnostics: [{}] }, { usageDiagnostics: [{ code: "unknown", sourceOrder: 4 }] },
    { usageDiagnostics: [{ code: "unidentified-claude-call", sourceOrder: 0 }] },
  ] as unknown as Partial<Batch>[]) {
    assert.equal(await store.commit({ ...write, ...fields }), "invalid", JSON.stringify(fields));
    assert.deepEqual(await store.readSession(source), before);
    assert.deepEqual(await store.readCheckpoint(source), { version: 1, checkpoint: first.checkpoint });
  }
  for (const fields of [{ claudeUsageReports: [claudeReport()] }, { usageDiagnostics: [{ code: "invalid-claude-usage", sourceOrder: 1 }] }]) {
    assert.equal(await store.commit(batch(0, 0, { source: codexSource, ...fields } as Partial<Batch>)), "invalid");
  }
});

test("typed usage enforces Claude status, identity and duration shapes and keeps legacy records valid", async () => {
  const store = new InMemoryCollectorStorage();
  for (const fields of [
    { kind: "call", status: "invalid" }, { kind: "interval", status: "final" }, { messageId: "m" },
    { kind: "call", messageId: "" }, { kind: "call", iterationId: 3 },
    { kind: "call", cacheWriteTokens: 1, cacheWrite1hTokens: 3 }, { cacheWrite5mTokens: 0 },
  ] as unknown as Partial<Usage>[]) {
    assert.equal(await store.commit(batch(0, 0, { usage: [request(fields)] })), "invalid", JSON.stringify(fields));
  }
  const legacy = request();
  assert.equal(await store.commit(batch(0, 0, { usage: [legacy] })), "committed");
  assert.deepEqual((await store.readSession(source))?.usage, [legacy]);
});

test("Claude adds usage at an old checkpoint while preserving its recorded chat decoder", async () => {
  const saved = { ["a".repeat(64)]: 2 };
  const next = { offset: 10, parserState: claudeParserState(2, saved) };
  for (const old of [claudeParserState(1, saved), "", " { } "]) {
    const store = new InMemoryCollectorStorage();
    const checkpoint = { offset: 10, parserState: old };
    assert.equal(await store.commit(batch(0, 0, { checkpoint, messages: [planning] })), "committed");
    const upgrade = batch(1, 10, { checkpoint: next, upgradeFromParserState: old, claudeUsageReports: [claudeReport()] });
    assert.equal(await store.commit({ ...upgrade, upgradeFromParserState: "unmatched" }), "conflict");
    assert.equal(await store.commit({ ...upgrade, messages: [planning] }), "invalid");
    assert.equal(await store.commit({ ...upgrade, metadata: { cwd: "/new" } }), "invalid");
    if (old === claudeParserState(1, saved)) {
      for (const parserState of [claudeParserState(2), claudeParserState(2, saved, 3), codexParserState(2), claudeParserState(1, saved)]) {
        assert.equal(await store.commit({ ...upgrade, checkpoint: { ...next, parserState } }), "invalid");
      }
    }
    assert.deepEqual(await store.readCheckpoint(source), { version: 1, checkpoint });
    assert.equal(await store.commit(upgrade), "committed");
    assert.deepEqual(await store.readCheckpoint(source), { version: 2, checkpoint: next });
    const view = await store.readSession(source);
    assert.equal(view?.observedTotalTokens, 42);
    assert.deepEqual(view.messages, [planning]);
  }
});
