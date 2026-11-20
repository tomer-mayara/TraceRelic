import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import type { Batch } from "../../../src/storage/collector-storage.ts";
import { CodexRolloutFixture } from "../../fixtures/codex-rollout-fixture.ts";
import { CodexUsageFixture as Codex } from "../../fixtures/codex-usage-fixture.ts";
import { RewriteScanFixture } from "../../fixtures/rewrite-scan-fixture.ts";
import { appendTranscriptBytes } from "../../fixtures/transcript-gap-fixture.ts";

test("leading blank lines preserve a fresh Codex baseline and a nonblank preamble leaves it uncertain", async t => {
  for (const [prefix, total, coverage] of [[" \t\r\n\n", 90, "reported"], ["{broken\n", 20, "partial"], ["{}\n", 20, "partial"]] as const) {
    const fixture = await RewriteScanFixture.create();
    t.after(() => fixture.close());
    await fixture.write([Codex.report(Codex.counts(70, 0)), fixture.call("known", 20)]);
    await writeFile(fixture.file, prefix + await readFile(fixture.file, "utf8"));
    const view = await fixture.scan();
    assert.equal(view.observedTotalTokens, total);
    assert.equal(view.coverage, coverage);
    assert.deepEqual(await fixture.scan(), view);
  }
});

test("an unfinished malformed line waits for its newline, then reports its bytes before any measurement exists", async t => {
  const fixture = await RewriteScanFixture.create();
  t.after(() => fixture.close());
  await fixture.append(CodexRolloutFixture.message(fixture.header.timestamp, "naïve"));
  const original = await fixture.scan();
  const accepted = await fixture.storage.readCheckpoint(fixture.source);
  const raw = Buffer.concat([Buffer.from('{"private":"café'), Buffer.from([0xff]), Buffer.from(' hidden"}\r\n')]);
  const partial = await appendTranscriptBytes(fixture.file, raw.subarray(0, -1));
  assert.deepEqual(await fixture.scan(), original);
  assert.deepEqual(await fixture.storage.readCheckpoint(fixture.source), accepted);
  await appendTranscriptBytes(fixture.file, raw.subarray(-1));

  const damaged = await fixture.scan();
  assert.equal(damaged.coverage, "unknown");
  assert.equal(damaged.observedTotalTokens, null);
  const { streamId, installationId } = fixture.source;
  assert.deepEqual(damaged.usageDiagnostics, [{ streamId, installationId, sourceOrder: 3, code: "malformed-transcript-line",
    byteRange: { startOffset: partial.startOffset, endOffset: partial.startOffset + raw.length } }]);
  const progress = await fixture.storage.readCheckpoint(fixture.source);
  assert.equal(progress.checkpoint?.offset, partial.startOffset + raw.length);
  assert.doesNotMatch(JSON.stringify([damaged.usageDiagnostics, progress]), /private|café|hidden/);

  await fixture.append(fixture.call("zero", 0));
  const measured = await fixture.scan();
  assert.equal(measured.coverage, "partial");
  assert.equal(measured.observedTotalTokens, 0);
  assert.equal(measured.usage.length, 1);
  assert.deepEqual(measured.usageDiagnostics, damaged.usageDiagnostics);
});

test("a rejected gap batch rolls back its message, measurement and checkpoint together", async t => {
  const fixture = await RewriteScanFixture.create();
  t.after(() => fixture.close());
  await fixture.append(fixture.call("first", 70));
  const original = await fixture.scan();
  const accepted = await fixture.storage.readCheckpoint(fixture.source);
  const bytes = await appendTranscriptBytes(fixture.file, '{"payload":"private row"\n');
  await fixture.append(CodexRolloutFixture.message(fixture.header.timestamp, "Continue"));
  await fixture.append(fixture.call("second", 20));
  const store = fixture.storage;
  const commit = store.commit.bind(store);
  const reject = t.mock.method(store, "commit", (batch: Batch) => commit({
    ...batch, checkpoint: { ...batch.checkpoint, prefixDigest: "broken" },
  }));
  await assert.rejects(fixture.scan(), /Storage returned invalid/);
  reject.mock.restore();
  assert.deepEqual(await store.readCheckpoint(fixture.source), accepted);
  assert.deepEqual(await store.readSession(fixture.source), original);

  const recovered = await fixture.scan();
  assert.deepEqual(recovered.messages.map(message => message.text), ["Continue"]);
  assert.equal(recovered.observedTotalTokens, 90);
  assert.equal(recovered.coverage, "partial");
  const { streamId, installationId } = fixture.source;
  assert.deepEqual(recovered.usageDiagnostics, [{ streamId, installationId, sourceOrder: 3,
    code: "malformed-transcript-line", byteRange: bytes }]);
  const file = await readFile(fixture.file, "utf8");
  // A change after the damaged bytes forces a full replay of the same bad line.
  await writeFile(fixture.file, file.slice(0, -1) + " \n");
  assert.deepEqual(await fixture.scan(), recovered);
});

for (const restart of [false, true]) {
  test(`Codex resumes deltas at its first reliable snapshot after damage ${restart ? "across a restart" : "in one batch"}`, async t => {
    const fixture = await RewriteScanFixture.create();
    t.after(() => fixture.close());
    const seventy = Codex.counts(70, 0);
    await fixture.append(Codex.report(seventy, seventy, { request_id: "first" }));
    await appendTranscriptBytes(fixture.file, "broken counter row\n");
    if (restart) {
      const interrupted = await fixture.scan();
      assert.equal(interrupted.observedTotalTokens, 70);
      const { checkpoint } = await fixture.storage.readCheckpoint(fixture.source);
      assert(checkpoint);
      assert.equal(JSON.parse(checkpoint.parserState).version, 4);
    }
    await fixture.append(fixture.call("second", 20));
    await fixture.append(Codex.report(Codex.counts(500, 0)));
    await fixture.append(Codex.report(Codex.counts(510, 0)));
    const measured = await fixture.scan();
    assert.equal(measured.observedTotalTokens, 100);
    assert.equal(measured.coverage, "partial");
    assert.deepEqual(measured.usage.map(item => item.inputTokens).sort((a, b) => a - b), [10, 20, 70]);
    assert.deepEqual(await fixture.scan(), measured);
  });
}

test("backfilling a text-only checkpoint at the damaged line preserves a pending baseline across restart", async t => {
  const fixture = await RewriteScanFixture.create();
  t.after(() => fixture.close());
  const seventy = Codex.counts(70, 0);
  await fixture.append(Codex.report(seventy, seventy, { request_id: "known" }));
  const range = await appendTranscriptBytes(fixture.file, "{broken\n");
  const store = fixture.storage;
  const commit = store.commit.bind(store);
  const legacy = t.mock.method(store, "commit", (batch: Batch) => {
    const { lineNumber, decoder } = JSON.parse(batch.checkpoint.parserState);
    const parserState = JSON.stringify({ version: 1, lineNumber, decoder: decoder.chat });
    return commit({ ...batch, usage: [], usageWindows: [], usageAnchors: [], hasGap: false, usageDiagnostics: [],
      checkpoint: { ...batch.checkpoint, parserState } });
  });
  assert.equal((await fixture.scan()).observedTotalTokens, null);
  legacy.mock.restore();
  const before = await store.readCheckpoint(fixture.source);
  const backfilled = await fixture.scan();
  assert.equal(backfilled.observedTotalTokens, 70);
  assert.equal(backfilled.coverage, "partial");
  const { streamId, installationId } = fixture.source;
  assert.deepEqual(backfilled.usageDiagnostics, [{ streamId, installationId, sourceOrder: 3,
    code: "malformed-transcript-line", byteRange: range }]);
  const upgraded = await store.readCheckpoint(fixture.source);
  assert(upgraded.checkpoint);
  assert.equal(upgraded.checkpoint.offset, before.checkpoint?.offset);
  assert.equal(upgraded.version, before.version + 1);
  assert.equal(JSON.parse(upgraded.checkpoint.parserState).version, 4);
  await fixture.append(Codex.report(Codex.counts(500, 0)));
  await fixture.append(Codex.report(Codex.counts(510, 0)));
  assert.equal((await fixture.scan()).observedTotalTokens, 80);
});

test("a rewrite can reserve anonymous message IDs while its counter baseline is pending", async t => {
  const fixture = await RewriteScanFixture.create();
  t.after(() => fixture.close());
  const prompt = CodexRolloutFixture.message(fixture.header.timestamp, "Repeat");
  const call = fixture.call("first", 70);
  await fixture.write([call, prompt, prompt]);
  const original = await fixture.scan();
  await fixture.write([call, prompt]);
  await appendTranscriptBytes(fixture.file, "{broken\n");
  const rewritten = await fixture.scan();
  assert.deepEqual(rewritten.messages, original.messages);
  const { checkpoint } = await fixture.storage.readCheckpoint(fixture.source);
  assert(checkpoint);
  assert.equal(JSON.parse(checkpoint.parserState).version, 4);

  await fixture.append(prompt);
  await fixture.append(Codex.report(Codex.counts(500, 0)));
  await fixture.append(Codex.report(Codex.counts(510, 0)));
  const appended = await fixture.scan();
  assert.equal(appended.messages.length, 3);
  assert.equal(new Set(appended.messages.map(message => message.id)).size, 3);
  assert.equal(appended.observedTotalTokens, 80);
  assert.equal(appended.coverage, "partial");
  assert.deepEqual(await fixture.scan(), appended);
});

test("valid Codex bookkeeping keeps full coverage and lost usage reports identify their exact source ranges", async t => {
  const fixture = await RewriteScanFixture.create();
  t.after(() => fixture.close());
  const seventy = Codex.counts(70, 0);
  await fixture.append(Codex.report(seventy, seventy, { request_id: "known" }));
  await appendTranscriptBytes(fixture.file, " \t\r\n");
  await fixture.append(Codex.report(undefined, undefined, { info: null, rate_limits: { used_percent: 30 } }));
  await fixture.append(Codex.report(Codex.counts(75, 0)));
  const clean = await fixture.scan();
  assert.equal(clean.coverage, "reported");
  assert.equal(clean.observedTotalTokens, 75);
  assert.equal(clean.usageDiagnostics, undefined);

  const unmeasured = Codex.report({ future_units: "private counter value" });
  const unsupported = await appendTranscriptBytes(fixture.file, JSON.stringify(unmeasured) + "\r\n");
  await fixture.append(Codex.report(Codex.counts(500, 0), Codex.counts(20, 0), { request_id: "at-baseline" }));
  await fixture.append(Codex.report(Codex.counts(515, 0)));
  const resetRow = Codex.report(Codex.counts(3, 0), Codex.counts(3, 0), { request_id: "at-reset" });
  const reset = await appendTranscriptBytes(fixture.file, JSON.stringify(resetRow) + "\n");
  await fixture.append(Codex.report(Codex.counts(8, 0)));
  const updated = await fixture.scan();
  const { streamId, installationId } = fixture.source;
  assert.deepEqual(updated.usageDiagnostics, [
    { streamId, installationId, sourceOrder: 6, code: "unsupported-codex-usage", byteRange: unsupported },
    { streamId, installationId, sourceOrder: 9, code: "codex-counter-reset", byteRange: reset },
  ]);
  assert.equal(updated.coverage, "partial");
  assert.equal(updated.observedTotalTokens, 118);
  assert.deepEqual(await fixture.scan(), updated);
});
