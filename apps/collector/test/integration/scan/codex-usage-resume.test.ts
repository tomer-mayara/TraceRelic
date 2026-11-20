import assert from "node:assert/strict";
import { test } from "node:test";
import type { Batch, StreamKey } from "../../../src/storage/collector-storage.ts";
import { ScanCommandFixture } from "../../fixtures/scan-command-fixture.ts";

test("repeated cumulative reports resume from 200 and count the next 30 tokens once", async t => {
  const fixture = await ScanCommandFixture.create();
  t.after(() => fixture.close());
  await fixture.configure();
  await fixture.writeCumulativeReports(120, 120, 200);
  await fixture.scan();
  const first = await fixture.storage.readSession(fixture.codexKey);
  assert.equal(first?.observedTotalTokens, 200);
  assert.equal(first.coverage, "reported");
  assert.deepEqual(first.usage.map(u => u.inputTokens + u.outputTokens).sort((a, b) => a - b), [80, 120]);
  fixture.restart();
  await fixture.scan();
  assert.deepEqual(await fixture.storage.readSession(fixture.codexKey), first);
  await fixture.appendCodexCall(30);
  await fixture.scan();
  const next = await fixture.storage.readSession(fixture.codexKey);
  assert.equal(next?.observedTotalTokens, 230);
  assert.deepEqual(next.messages, first.messages);
  assert.deepEqual(next.usage.filter(u => first.usage.some(prev => prev.id === u.id)), first.usage);
});

for (const append of [false, true]) {
  test(`backfills a text-only checkpoint ${append ? "with a new batch" : "at end of file"}`, async t => {
    const fixture = await ScanCommandFixture.create();
    t.after(() => fixture.close());
    await fixture.configure();
    await fixture.writeCumulativeReports(120, 120, 200);
    const storage = fixture.storage;
    const commit = storage.commit.bind(storage);
    let source: StreamKey | undefined;
    const old = t.mock.method(storage, "commit", (batch: Batch) => {
      source = batch.source;
      const state = JSON.parse(batch.checkpoint.parserState);
      const parserState = JSON.stringify({ version: 1, lineNumber: state.lineNumber, decoder: state.decoder.chat ?? state.decoder });
      return commit({ ...batch, usage: [], usageWindows: [], checkpoint: { ...batch.checkpoint, parserState } });
    });
    await fixture.scan();
    old.mock.restore();
    assert(source);
    const before = await storage.readCheckpoint(source);
    assert(before.checkpoint);
    const previous = await storage.readSession(source);
    assert(previous);
    assert.equal(previous.observedTotalTokens, null);
    const oldTexts = previous.messages;
    fixture.restart();
    if (append) await fixture.appendCodexCall(30);
    const reject = t.mock.method(storage, "commit", async () => "invalid" as const);
    await assert.rejects(fixture.scan(), /Storage returned invalid/);
    reject.mock.restore();
    assert.deepEqual(await storage.readCheckpoint(source), before);
    assert.deepEqual(await storage.readSession(source), previous);
    await fixture.scan();
    const upgraded = await storage.readCheckpoint(source);
    assert(upgraded.checkpoint);
    assert.equal(upgraded.version, before.version + 1);
    assert.equal(JSON.parse(upgraded.checkpoint.parserState).version, 2);
    if (append) assert(upgraded.checkpoint.offset > before.checkpoint.offset);
    else assert.equal(upgraded.checkpoint.offset, before.checkpoint.offset);
    const measured = await storage.readSession(source);
    assert.equal(measured?.observedTotalTokens, append ? 230 : 200);
    assert.deepEqual(measured.messages, oldTexts);
    fixture.restart();
    const [again] = await fixture.scan();
    assert.deepEqual(again, measured);
    assert.deepEqual(await storage.readCheckpoint(source), upgraded);
  });
}
