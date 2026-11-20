import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { test } from "node:test";
import type { Batch, StreamKey } from "../../../src/storage/collector-storage.ts";
import { ClaudeProjectFixture } from "../../fixtures/claude-project-fixture.ts";
import { ScanCommandFixture } from "../../fixtures/scan-command-fixture.ts";

for (const saved of ["empty", "version 1"]) {
  test(`backfills a Claude checkpoint (${saved}) while the next row is incomplete`, async t => {
    const fixture = await ScanCommandFixture.create();
    t.after(() => fixture.close());
    await fixture.configure();
    await fixture.writeClaudeRequest(40, 2, 91);
    const store = fixture.storage;
    const commit = store.commit.bind(store);
    let source: StreamKey | undefined;
    const older = t.mock.method(store, "commit", (batch: Batch) => {
      source = batch.source;
      const state = JSON.parse(batch.checkpoint.parserState);
      const parserState = saved === "empty" ? "{}" : JSON.stringify({ ...state, version: 1 });
      return commit({ ...batch, claudeUsageReports: [], usageDiagnostics: [], checkpoint: { ...batch.checkpoint, parserState } });
    });
    await fixture.scan();
    older.mock.restore();
    assert(source);
    const before = await store.readCheckpoint(source);
    const original = await store.readSession(source);
    assert(before.checkpoint && original);
    assert.equal(original.observedTotalTokens, null);
    const extra = ClaudeProjectFixture.assistant(source.sessionId, "2026-02-01T12:03:00Z", "Next answer");
    const row = JSON.stringify({ ...extra, uuid: "next-answer" });
    await appendFile(source.streamId, row);
    fixture.restart();
    const reject = t.mock.method(store, "commit", async () => "invalid" as const);
    await assert.rejects(fixture.scan(), /Storage returned invalid/);
    reject.mock.restore();
    assert.deepEqual(await store.readCheckpoint(source), before);

    await fixture.scan();
    const upgraded = await store.readCheckpoint(source);
    const accepted = await store.readSession(source);
    assert(upgraded.checkpoint && accepted);
    assert.equal(upgraded.version, before.version + 1);
    assert.equal(upgraded.checkpoint.offset, before.checkpoint.offset);
    assert.equal(JSON.parse(upgraded.checkpoint.parserState).version, 2);
    assert.equal(accepted.observedTotalTokens, 131);
    assert.equal(accepted.usage[0].revision, 2);
    assert.deepEqual(accepted.messages, original.messages);
    await appendFile(source.streamId, "\n");
    fixture.restart();
    await fixture.scan();
    const appended = await store.readSession(source);
    assert.equal(appended?.observedTotalTokens, 203);
    assert.deepEqual(appended.messages.slice(0, -1), accepted.messages);
    assert.equal(appended.messages.at(-1)?.text, "Next answer");
  });
}
