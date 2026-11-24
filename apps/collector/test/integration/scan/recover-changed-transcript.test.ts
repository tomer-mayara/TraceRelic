import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, truncate } from "node:fs/promises";
import { basename, join } from "node:path";
import { test } from "node:test";
import { CodexHistory } from "@tracerelic/collector/providers";
import type { ReadPosition, ScanSelection } from "@tracerelic/collector/transcript";
import type { Batch } from "../../../src/storage/collector-storage.ts";
import { CodexRolloutFixture as Rollout } from "../../fixtures/codex-rollout-fixture.ts";
import { textOnlyBatch } from "../../fixtures/collector-storage-fixture.ts";
import { RewriteScanFixture } from "../../fixtures/rewrite-scan-fixture.ts";

test("moving a rollout to the archive verifies the old prefix and resumes at its saved byte", async t => {
  const fixture = await RewriteScanFixture.create();
  t.after(() => fixture.close());
  await fixture.write([fixture.call("a", 120)]);
  const original = await fixture.scan();
  const before = await fixture.storage.readCheckpoint(fixture.source);
  assert(before.checkpoint);
  const archive = join(fixture.root.home, "archived_sessions");
  await mkdir(archive);
  const file = join(archive, basename(fixture.file));
  await rename(fixture.file, file);
  fixture.file = file;
  assert.deepEqual(await fixture.scan(), original);
  assert.deepEqual(await fixture.storage.readCheckpoint(fixture.source), before);

  const reads: ReadPosition[] = [];
  const discover = CodexHistory.prototype.discoverSources;
  t.mock.method(CodexHistory.prototype, "discoverSources", async function* (
    this: CodexHistory, selection?: ScanSelection,
  ) {
    for await (const source of discover.call(this, selection)) {
      yield { ...source, readBatches(position: ReadPosition, budget?: number, end?: number) {
        reads.push(position);
        return source.readBatches(position, budget, end);
      } };
    }
  });
  await fixture.append(fixture.call("b", 30));
  const appended = await fixture.scan();
  assert.deepEqual(reads, [{ offset: before.checkpoint.offset, lineNumber: 2 }]);
  assert.equal(appended.observedTotalTokens, 150);
  assert(appended.usage.some(row => row.id === original.usage[0].id));
});

test("a same-length rewrite with the same final 96 KiB imports the changed middle", async t => {
  const fixture = await RewriteScanFixture.create();
  t.after(() => fixture.close());
  const tail = { padding: "x".repeat(96 * 1024) };
  await fixture.write([fixture.call("a", 120), tail]);
  const first = await fixture.scan();
  const before = await fixture.storage.readCheckpoint(fixture.source);
  await fixture.write([fixture.call("b", 130), tail]);
  const replacement = await readFile(fixture.file);
  const second = await fixture.scan();
  assert.equal(second.observedTotalTokens, 250);
  assert.equal(second.coverage, "reported");
  assert.deepEqual(second.usage.filter(row => row.id === first.usage[0].id), first.usage);
  const after = await fixture.storage.readCheckpoint(fixture.source);
  assert(after.checkpoint && before.checkpoint);
  assert.equal(after.version, before.version + 1);
  assert.equal(after.checkpoint.offset, before.checkpoint.offset);
  assert.equal(after.checkpoint.prefixDigest, createHash("sha256").update(replacement).digest("hex"));
  assert.notEqual(after.checkpoint.prefixDigest, before.checkpoint.prefixDigest);
  assert.deepEqual(await fixture.scan(), second);
  assert.deepEqual(await fixture.storage.readCheckpoint(fixture.source), after);
});

test("a truncation retains accepted calls and allows a later append before the original byte", async t => {
  const fixture = await RewriteScanFixture.create();
  t.after(() => fixture.close());
  await fixture.write([fixture.call("a", 120), fixture.call("b", 30)], 1200);
  const first = await fixture.scan();
  const before = await fixture.storage.readCheckpoint(fixture.source);
  await fixture.write([fixture.call("a", 120)]);
  assert.deepEqual(await fixture.scan(), first);
  const reset = await fixture.storage.readCheckpoint(fixture.source);
  assert(reset.checkpoint && before.checkpoint);
  assert(reset.checkpoint.offset < before.checkpoint.offset);
  assert(reset.version > before.version);
  await fixture.append(fixture.call("c", 20));
  const appended = await fixture.scan();
  assert.equal(appended.observedTotalTokens, 170);
  assert.equal(appended.usage.length, 3);
});

test("a shortened file rebuilds a digestless text-only checkpoint and preserves its accepted message", async t => {
  const fixture = await RewriteScanFixture.create();
  t.after(() => fixture.close());
  const message = Rollout.message(fixture.header.timestamp, "Keep this answer");
  const native = { ...message, payload: { ...message.payload, id: "item" } };
  await fixture.write([native, fixture.call("a", 120)], 1000);
  const commit = fixture.storage.commit.bind(fixture.storage);
  const older = t.mock.method(fixture.storage, "commit", (batch: Batch) => {
    const { lineNumber, decoder } = JSON.parse(batch.checkpoint.parserState);
    return commit(textOnlyBatch(batch, {
      offset: batch.checkpoint.offset, parserState: JSON.stringify({ version: 1, lineNumber, decoder: decoder.chat }),
    }));
  });
  const original = await fixture.scan();
  older.mock.restore();
  assert.equal(original.observedTotalTokens, null);
  await fixture.write([fixture.call("b", 30)]);
  const recovered = await fixture.scan();
  assert.deepEqual(recovered.messages, original.messages);
  assert.equal(recovered.observedTotalTokens, 30);
  const checkpoint = (await fixture.storage.readCheckpoint(fixture.source)).checkpoint;
  assert(checkpoint);
  assert.equal(JSON.parse(checkpoint.parserState).version, 2);
  assert.equal(checkpoint.prefixDigest, createHash("sha256").update(await readFile(fixture.file)).digest("hex"));
});

test("a shortened file pauses at an unsupported newer parser state", async t => {
  const fixture = await RewriteScanFixture.create();
  t.after(() => fixture.close());
  await fixture.write([fixture.call("a", 120)], 800);
  const commit = fixture.storage.commit.bind(fixture.storage);
  const newer = t.mock.method(fixture.storage, "commit", (batch: Batch) => {
    const saved = JSON.parse(batch.checkpoint.parserState);
    return commit({ ...batch, checkpoint: {
      ...batch.checkpoint, parserState: JSON.stringify({ ...saved, version: 99 }),
    } });
  });
  const original = await fixture.scan();
  newer.mock.restore();
  const before = await fixture.storage.readCheckpoint(fixture.source);
  await fixture.write([fixture.call("b", 30)]);
  await assert.rejects(fixture.scan(), (error: Error) => {
    assert.match(error.message, /Unsupported parser version/);
    assert(error.message.includes(fixture.file));
    assert(error.message.includes("800"));
    return true;
  });
  assert.deepEqual(await fixture.storage.readSession(fixture.source), original);
  assert.deepEqual(await fixture.storage.readCheckpoint(fixture.source), before);
});

test("a truncation inside the session header preserves accepted history until the file identifies its session again", async t => {
  const fixture = await RewriteScanFixture.create();
  t.after(() => fixture.close());
  await fixture.write([fixture.call("a", 120)]);
  const first = await fixture.scan();
  const saved = await fixture.storage.readCheckpoint(fixture.source);
  for (const size of [5, 0]) {
    await truncate(fixture.file, size);
    assert.deepEqual(await fixture.scanAll(), []);
    assert.deepEqual(await fixture.storage.readCheckpoint(fixture.source), saved);
    assert.deepEqual(await fixture.storage.readSession(fixture.source), first);
  }
  await fixture.write([fixture.call("b", 30)]);
  const recovered = await fixture.scan();
  assert.equal(recovered.observedTotalTokens, 150);
  assert.equal(recovered.usage.length, 2);
});

test("removing one identical anonymous prompt preserves both originals and a later identical append is distinct", async t => {
  const fixture = await RewriteScanFixture.create();
  t.after(() => fixture.close());
  const text = Rollout.message(fixture.header.timestamp, "Run the check");
  const call = fixture.call("a", 17);
  await fixture.write([call, text, text]);
  const first = await fixture.scan();
  assert.equal(first.coverage, "reported");
  assert.equal(new Set(first.messages.map(message => message.id)).size, 2);
  await fixture.write([call, text]);
  const recovered = await fixture.scan();
  assert.deepEqual(recovered.messages, first.messages);
  assert.equal(recovered.observedTotalTokens, 17);
  assert.equal(recovered.coverage, "partial");
  assert(recovered.usageDiagnostics?.some(row => row.code === "ambiguous-transcript-replay" && row.sourceOrder === 3));
  const { checkpoint } = await fixture.storage.readCheckpoint(fixture.source);
  assert(checkpoint);
  assert.equal(JSON.parse(checkpoint.parserState).version, 3);
  assert.deepEqual(await fixture.scan(), recovered);
  await fixture.append(text);
  const appended = await fixture.scan();
  assert.equal(appended.messages.length, 3);
  assert.equal(new Set(appended.messages.map(message => message.id)).size, 3);
  assert.deepEqual(appended.messages.filter(message => first.messages.some(old => old.id === message.id)), first.messages);
  assert.deepEqual(await fixture.scan(), appended);
});

test("a unique match still depends on the unread bytes used to establish it", async t => {
  const fixture = await RewriteScanFixture.create();
  t.after(() => fixture.close());
  const text = Rollout.message(fixture.header.timestamp, "Repeat");
  await fixture.write([text]);
  const first = await fixture.scan();
  const padding = { padding: "x".repeat(300 * 1024) };
  await fixture.write([padding, text], 304 * 1024);
  const store = fixture.storage;
  const commit = store.commit.bind(store);
  const refuseSecond = t.mock.method(store, "commit", (batch: Batch) =>
    batch.resetFrom ? commit(batch) : Promise.resolve("invalid" as const));
  await assert.rejects(fixture.scan(), /Storage returned invalid/);
  refuseSecond.mock.restore();
  const { checkpoint } = await store.readCheckpoint(fixture.source);
  assert(checkpoint?.replayThrough);
  await fixture.write([padding, text, text], checkpoint.replayThrough.offset + 512);
  const recovered = await fixture.scan();
  assert.deepEqual(recovered.messages, first.messages);
  assert(recovered.usageDiagnostics?.some(row => row.code === "ambiguous-transcript-replay"));
});

for (const suffix of ["unchanged", "rewritten at the same length", "rewritten and extended", "extended by an append"] as const) {
  test(`an interrupted replay preserves both original prompts when its unread suffix is ${suffix}`, async t => {
    const fixture = await RewriteScanFixture.create();
    t.after(() => fixture.close());
    const text = Rollout.message(fixture.header.timestamp, "Repeat");
    const call = fixture.call("a", 17);
    await fixture.write([call, text, text]);
    const original = await fixture.scan();
    const before = await fixture.storage.readCheckpoint(fixture.source);
    // The prompt is in the unread suffix, beyond the first rebuilt batch.
    const padding = { padding: "x".repeat(300 * 1024) };
    const capturedSize = 304 * 1024;
    await fixture.write([call, padding, text], capturedSize);
    const commit = fixture.storage.commit.bind(fixture.storage);
    const refuseSecond = t.mock.method(fixture.storage, "commit", (batch: Batch) =>
      batch.expectedVersion === before.version + 1 ? Promise.resolve("invalid" as const) : commit(batch));
    await assert.rejects(fixture.scan(), /Storage returned invalid/);
    refuseSecond.mock.restore();
    const partial = await fixture.storage.readCheckpoint(fixture.source);
    assert.equal(partial.version, before.version + 1);
    assert(partial.checkpoint && before.checkpoint && partial.checkpoint.offset < before.checkpoint.offset);

    if (suffix === "extended by an append") {
      await fixture.append(text);
    } else if (suffix !== "unchanged") {
      const previous = await readFile(fixture.file);
      const size = suffix === "rewritten at the same length" ? capturedSize : capturedSize + 512;
      await fixture.write([call, padding, text, text], size);
      const replaced = await readFile(fixture.file);
      const offset = partial.checkpoint.offset;
      assert.deepEqual(replaced.subarray(0, offset), previous.subarray(0, offset));
      assert(!replaced.subarray(offset, capturedSize).equals(previous.subarray(offset)));
    }

    const recovered = await fixture.scan();
    const expectedCount = suffix === "extended by an append" ? 3 : 2;
    assert.equal(recovered.messages.length, expectedCount);
    assert.deepEqual(recovered.messages.filter(message => original.messages.some(prior => prior.id === message.id)), original.messages);
    assert.equal(recovered.coverage, "partial");
    assert.equal(recovered.observedTotalTokens, 17);
    await fixture.append(text);
    const appended = await fixture.scan();
    assert.equal(appended.messages.length, expectedCount + 1);
    assert.equal(new Set(appended.messages.map(message => message.id)).size, expectedCount + 1);
    assert.deepEqual(await fixture.scan(), appended);
  });
}
