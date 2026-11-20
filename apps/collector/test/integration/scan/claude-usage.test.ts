import assert from "node:assert/strict";
import { rename } from "node:fs/promises";
import { test } from "node:test";
import type { Batch, CommitResult, SessionView, StreamKey } from "../../../src/storage/collector-storage.ts";
import { ClaudeUsageScanFixture } from "../../fixtures/claude-usage-scan-fixture.ts";

for (const winningFinal of [true, false]) {
  test(winningFinal ? "retry keeps the winning lower final report" :
    "retry applies a dominating provisional correction once", async t => {
    const fixture = await ClaudeUsageScanFixture.create();
    t.after(() => fixture.close());
    const earlier = fixture.report(1, { input_tokens: 10, output_tokens: 4 }, { text: "First response", uuid: "text" });
    const independent = fixture.report(2, { input_tokens: 1, output_tokens: 2 }, { request: "other" });
    await fixture.append("desktop", earlier, independent);
    const initial = await fixture.scan("desktop");

    const winnerOutput = winningFinal ? 2 : 8;
    const winner = fixture.report(3, { input_tokens: 10, output_tokens: winnerOutput }, { final: winningFinal });
    const candidate = fixture.report(4, { input_tokens: 10, output_tokens: 12 });
    await fixture.append("desktop", winner);
    await fixture.append("laptop", candidate);
    const commit = fixture.storage.commit.bind(fixture.storage);
    const checkpoint = fixture.storage.readCheckpoint.bind(fixture.storage);
    const versions: number[] = [];
    const outcomes: CommitResult[] = [];
    let winningView: SessionView | undefined;
    let winningVersion: number | undefined;
    t.mock.method(fixture.storage, "readCheckpoint", async (source: StreamKey) => {
      const snapshot = await checkpoint(source);
      if (source.installationId === "laptop") versions.push(snapshot.version);
      return snapshot;
    });
    t.mock.method(fixture.storage, "commit", async (batch: Batch) => {
      if (batch.source.installationId === "desktop") {
        winningVersion = batch.expectedVersion;
        return commit(batch);
      }
      if (!winningView) {
        winningView = await fixture.scan("desktop");
        assert.equal(winningVersion, batch.expectedVersion);
      }
      const outcome = await commit(batch);
      outcomes.push(outcome);
      return outcome;
    });

    const result = await fixture.scan("laptop");
    assert(winningView);
    assert.deepEqual(outcomes, ["conflict", "committed"]);
    assert(winningVersion !== undefined);
    assert(versions.includes(winningVersion) && versions.includes(winningVersion + 1));
    const [original, otherCall] = initial.usage;
    assert.deepEqual(initial.usage.map(row => row.requestId), ["request-primary", "request-other"]);
    assert.deepEqual(winningView.usage[1], otherCall);
    assert.partialDeepStrictEqual(winningView.usage[0], {
      id: original.id, at: earlier.timestamp, revision: 2, outputTokens: winnerOutput,
    });
    const outputTokens = winningFinal ? winnerOutput : 12;
    assert.equal(result.observedTotalTokens, 10 + outputTokens + 3);
    assert.equal(result.coverage, "reported");
    assert.equal(result.usage.length, 2);
    assert.deepEqual(result.usage[1], otherCall);
    assert.partialDeepStrictEqual(result.usage[0], { id: original.id, at: original.at, outputTokens,
      revision: winningFinal ? 2 : 3, status: winningFinal ? "final" : "provisional" });
    assert.deepEqual(result.messages, initial.messages);
    await fixture.append("laptop", earlier, candidate);
    assert.deepEqual(await fixture.scan("laptop"), result);
    assert.deepEqual(await fixture.scan("desktop"), result);
  });
}

test("orphaned and superseded tool-only reports without row UUIDs retain their native call identities", async t => {
  const fixture = await ClaudeUsageScanFixture.create();
  t.after(() => fixture.close());
  const { desktop } = fixture.roots;
  const session = fixture.key.sessionId;
  const orphan = fixture.report(1, { input_tokens: 10, output_tokens: 4 });
  const corrected = fixture.report(2, { input_tokens: 10, output_tokens: 8 }, { final: true });
  const other = fixture.report(3, { input_tokens: 4, output_tokens: 5 }, { request: "other" });
  await desktop.write("project", session + ".orphaned-1700000000000-a", [orphan, other]);
  const copy = await desktop.write("project", "staged", [corrected, other]);
  await rename(copy, fixture.files.desktop + ".superseded-1700000000001");
  const result = await fixture.scan("desktop");
  assert.equal(result.coverage, "reported");
  assert.equal(result.observedTotalTokens, 27);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.usage.map(row => [row.requestId, row.inputTokens, row.outputTokens]).sort(), [
    ["request-other", 4, 5], ["request-primary", 10, 8],
  ]);
  assert.deepEqual(await fixture.scan("desktop"), result);
});

test("a disputed request stays out of the total after restart and replay until a final report resolves it", async t => {
  const fixture = await ClaudeUsageScanFixture.create();
  t.after(() => fixture.close());
  const initial = fixture.report(1, { input_tokens: 10, output_tokens: 3 });
  const independent = fixture.report(2, { input_tokens: 1, output_tokens: 4 }, { request: "other" });
  const divergent = fixture.report(3, { input_tokens: 8, output_tokens: 15 });
  await fixture.append("desktop", initial, independent);
  const before = await fixture.scan("desktop");
  assert.equal(before.observedTotalTokens, 18);
  await fixture.append("laptop", divergent);
  const disputed = await fixture.scan("laptop");
  assert.deepEqual(disputed.usage, [before.usage[1]]);
  assert.equal(disputed.observedTotalTokens, 5);
  assert.equal(disputed.coverage, "partial");
  await fixture.append("desktop", initial, divergent);
  assert.deepEqual(await fixture.scan("desktop"), disputed);

  const final = fixture.report(4, { input_tokens: 7, output_tokens: 6 }, { final: true });
  await fixture.append("laptop", final);
  const resolved = await fixture.scan("laptop");
  assert.equal(resolved.observedTotalTokens, 18);
  assert.equal(resolved.coverage, "partial");
  assert.equal(resolved.usage.length, 2);
  assert.partialDeepStrictEqual(resolved.usage[0], {
    id: before.usage[0].id, at: initial.timestamp, status: "final", inputTokens: 7, outputTokens: 6,
  });
  assert.deepEqual(resolved.usage[1], before.usage[1]);
  assert.deepEqual(await fixture.scan("desktop"), resolved);
});
