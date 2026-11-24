import assert from "node:assert/strict";
import { test } from "node:test";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ScanRejectedError } from "@tracerelic/collector/scan";
import { CollectorCommand } from "@tracerelic/collector/command";
import { CodexRolloutFixture } from "#collector-fixture/codex-rollout-fixture";
import { PackedBatches, batchPartBytes } from "@tracerelic/collector/wire-contract";
import { CollectorApiFixture } from "../../fixtures/collector-api-fixture.ts";
import { batch, scope, source } from "../../fixtures/collector-wire-payloads.ts";
import { stagedUploads } from "../../fixtures/collector-database-write.ts";
import { DurableApiFixture } from "../../fixtures/durable-api-fixture.ts";

test("a packed append copies old parser bytes exactly, including replay reservations and fork data", () => {
  const one = (id: string) => ({ id, field: id.repeat(3) });
  const old = Array.from({ length: 18_000 }, (_, i) => one("old-" + i));
  const parser = (items: typeof old) => JSON.stringify({ version: 3, lineNumber: 20000,
    decoder: { seen: items, pending: items }, replayOccurrences: { remembered: { accepted: 4, replayed: 3 } } });
  const previous = parser(old);
  const input = { ...batch, expectedVersion: 1, expectedOffset: batch.checkpoint.offset,
    checkpoint: { ...batch.checkpoint, offset: 300, parserState: parser([...old, one("last")]) }, repairEvidenceFrom: { ...batch.checkpoint, parserState: previous } };
  const encoded = PackedBatches.pack(input, JSON.stringify(input), previous);
  assert(encoded.header.base);
  assert(encoded.bytes.length < 32_768);
  assert.deepEqual(PackedBatches.unpack(encoded.bytes, encoded.header, PackedBatches.stateBytes(previous)), input);
});

test("staged data survives an API restart and becomes visible only after an authenticated, verified final write", async t => {
  const fixture = await DurableApiFixture.open();
  t.after(() => fixture.close());
  const large = { ...batch, messages: Array.from({ length: 1400 }, (_, i) =>
    ({ ...batch.messages[0], id: "m-" + i, sourceOrder: i + 1, text: "ordinary message ".repeat(60) })) };
  const { header, bytes } = PackedBatches.pack(large, JSON.stringify(large));
  assert(header.parts && header.parts > 1);
  const api = await fixture.start();
  for (let index = 0; index < header.parts; index++) {
    const fragment = { transfer: "part-v1", upload: header.upload, index,
      data: bytes.toString("base64", index * batchPartBytes, (index + 1) * batchPartBytes) };
    assert.equal((await api.post("a", fragment)).status, 202);
    assert.equal((await api.post("a", fragment)).status, 202);
  }
  assert.equal(await api.a.readSession(source), null);
  const fresh = await fixture.restart();
  assert.equal((await fresh.post("b", header)).status, 422);
  assert.equal((await fresh.post("a", { ...header, decodedSha256: "f".repeat(64) })).status, 422);
  assert.equal(await fresh.a.readSession(source), null);
  assert.deepEqual(await Promise.all([fresh.post("a", header), fresh.post("a", header)]).then(rs => rs.map(r => r.status).sort()), [200,409]);
  assert.equal((await fresh.a.readSession(source))?.messages.length, large.messages.length);
});

test("equivalent stored aliases address one checkpoint and report one disappearance after restart", async t => {
  const fixture = await DurableApiFixture.open();
  t.after(() => fixture.close());
  const api = await fixture.start();
  const named = { ...batch.source, streamId: "rollout-plan.jsonl" };
  const observation = { ...batch.sourceObservation, location: { ...batch.sourceObservation.location, path: named.streamId } };
  const legacy = { ...named, streamId: JSON.stringify([scope.root, named.streamId]) };
  assert.equal(await api.a.commit({ ...batch, source: named, sourceObservation: observation }), "committed");
  assert.equal(await api.a.commit({ ...batch, source: legacy, sourceObservation: observation, expectedVersion: 1 }), "committed");
  assert.equal((await api.a.listSources(scope)).length, 1);
  const fresh = await fixture.restart();
  const presence = { source: legacy, location: observation.location, observedEnd: 100, expectedOffset: 100, expectedVersion: 2, presence: "missing" } as const;
  assert.equal(await fresh.a.recordPresence(presence), "committed");
  const rows = await fresh.a.listSources(scope);
  assert.deepEqual(rows.map(row => [row.source.streamId, row.presence]), [[named.streamId, "missing"]]);
  assert.equal((await fresh.a.readSession(named))?.missingSources?.length, 1);
  assert.deepEqual(await fresh.a.readCheckpoint(legacy), await fresh.a.readCheckpoint(named));
});

test("an oversized indivisible message stops at its prior checkpoint while independent writes continue", async t => {
  const fixture = await CollectorApiFixture.open();
  t.after(() => fixture.close());
  const api = fixture.client;
  const root = await CodexRolloutFixture.create();
  t.after(() => root.close());
  const config = join(root.home, "config.json");
  await writeFile(config, JSON.stringify({ codexPath: root.home, installationId: "desktop" }));
  const large = await root.write([CodexRolloutFixture.header("long"), CodexRolloutFixture.message("2026-01-01T00:00:00Z", "x".repeat(1_048_576))]);
  await rename(large, join(dirname(large), "rollout-long.jsonl"));
  await root.write([CodexRolloutFixture.header("independent"), CodexRolloutFixture.message("2026-01-01T00:00:00Z", "healthy")]);
  await assert.rejects(new CollectorCommand(api).run(["scan", "--once", "--config", config]), error => {
    assert(error instanceof ScanRejectedError);
    assert.deepEqual(error.rejections.map(row => row.source.sessionId), ["long"]);
    return true;
  });
  assert.deepEqual((await api.readSession({ harness: "codex", sessionId: "independent" }))?.messages.map(row => row.text), ["healthy"]);
  assert.equal((await api.readSession({ harness: "codex", sessionId: "long" }))?.messages.length, 0);
});

test("divergent native checkpoints and opaque source names retain their independent inventory", async t => {
  const api = await CollectorApiFixture.open();
  t.after(() => api.close());
  for (const [index, path] of ["rollout-history.jsonl", "opaque.jsonl"].entries()) {
    const plain = { ...source, sessionId: path, streamId: path };
    const legacy = { ...plain, streamId: JSON.stringify([scope.root, path]) };
    const observation = { ...batch.sourceObservation, location: { ...batch.sourceObservation.location, path } };
    assert.equal(await api.a.commit({ ...batch, source: plain, sourceObservation: observation }), "committed");
    assert.equal(await api.a.commit({ ...batch, source: legacy, expectedVersion: 1, sourceObservation: observation,
      checkpoint: { ...batch.checkpoint, prefixDigest: index ? batch.checkpoint.prefixDigest : "b".repeat(64) } }), "committed");
    const rows = await api.a.listSources({ harness: "codex", root: scope.root, sessionIds: [path] });
    assert.deepEqual(rows.map(row => row.source.streamId).sort(), [path, legacy.streamId].sort());
  }
});

test("a matching checkpoint after a different generation keeps both native source records", async t => {
  const fixture = await CollectorApiFixture.open();
  t.after(() => fixture.close());
  const plain = { ...source, streamId: "rollout-generation.jsonl" };
  const legacy = { ...plain, streamId: JSON.stringify([scope.root, plain.streamId]) };
  const sourceObservation = { ...batch.sourceObservation, location: { ...batch.sourceObservation.location, path: plain.streamId } };
  const original = { ...batch.checkpoint, prefixDigest: "c".repeat(64) };
  assert.equal(await fixture.a.commit({ ...batch, source: legacy, sourceObservation, checkpoint: original }), "committed");
  assert.equal(await fixture.a.commit({ ...batch, source: plain, sourceObservation, expectedVersion: 1 }), "committed");
  assert.equal(await fixture.a.commit({ ...batch, source: legacy, sourceObservation, expectedVersion: 2, expectedOffset: original.offset,
    resetFrom: original }), "committed");
  assert.equal((await fixture.a.listSources(scope)).length, 2);
});

test("reading two equivalent old missing sources first reports one disappearance and clears its history flag on return", async t => {
  const fixture = await DurableApiFixture.open();
  t.after(() => fixture.close());
  const { a } = await fixture.start();
  const named = { ...source, streamId: "rollout-return.jsonl" };
  const legacy = { ...named, streamId: JSON.stringify([scope.root, named.streamId]) };
  const location = { ...batch.sourceObservation.location, path: named.streamId };
  const checkpoint = { ...batch.checkpoint, parserState: JSON.stringify({ version: 2, lineNumber: 1, decoder: {} }) };
  const initial = { ...batch, checkpoint, sourceObservation: { location, observedEnd: checkpoint.offset } };
  for (const [i, key] of [named, legacy].entries()) {
    assert.equal(await a.commit({ ...initial, source: key, expectedVersion: i * 2 }), "committed");
    assert.equal(await a.recordPresence({ location, source: key, presence: "missing", expectedVersion: i * 2 + 1,
      expectedOffset: checkpoint.offset, observedEnd: checkpoint.offset }), "committed");
  }
  const first = await a.readSession(named);
  assert.equal(first?.missingSources?.length, 1);
  assert.equal(first.coverage, "partial");
  assert.equal(first.usageDiagnostics?.filter(row => row.code === "unverified-source-history").length, 1);
  const fresh = await fixture.restart();
  assert.equal(await fresh.a.recordPresence({ location, source: legacy, presence: "present", expectedVersion: 4,
    expectedOffset: checkpoint.offset, observedEnd: checkpoint.offset }), "committed");
  const returned = await fresh.a.readSession(named);
  assert.equal(returned?.missingSources, undefined);
  assert.equal(returned?.usageDiagnostics, undefined);
  assert.equal(returned?.coverage, "reported");
});

test("a restarted idle API removes expired partial transfers", async t => {
  const fixture = await DurableApiFixture.open();
  t.after(() => fixture.close());
  const api = await fixture.start();
  assert.equal((await api.post("a", { transfer: "part-v1", index: 0, upload: "b".repeat(64), data: "YQ==" })).status, 202);
  assert.equal(await stagedUploads(fixture.databaseUrl, true), 1);
  await fixture.restart();
  assert.equal(await stagedUploads(fixture.databaseUrl), 0);
});

test("a verified canonical repair replaces old messages and measurements from both equivalent scanner keys", async t => {
  const fixture = await DurableApiFixture.open();
  t.after(() => fixture.close());
  const api = await fixture.start();
  const named = { ...source, streamId: "rollout-repair.jsonl" };
  const legacy = { ...named, streamId: JSON.stringify([scope.root, named.streamId]) };
  const sourceObservation = { ...batch.sourceObservation, location: { ...batch.sourceObservation.location, path: named.streamId } };
  assert.equal(await api.a.commit({ ...batch, source: named, sourceObservation }), "committed");
  assert.equal(await api.a.commit({ ...batch, source: legacy, sourceObservation, expectedVersion: 1 }), "committed");
  assert.equal((await api.a.listSources(scope)).length, 1);
  const fresh = await fixture.restart();
  const corrected = { ...batch, source: legacy, sourceObservation, repairEvidenceFrom: batch.checkpoint, expectedVersion: 2, expectedOffset: 100,
    checkpoint: { ...batch.checkpoint, evidenceVersion: 1 as const, parserState: JSON.stringify({ version: 2, lineNumber: 1, decoder: {} }) },
    messages: [{ ...batch.messages[0], id: "corrected", text: "one block" }],
    usage: [{ ...batch.usage[0], id: "corrected-call", inputTokens: 40 }] };
  assert.equal(await fresh.a.commit(corrected), "committed");
  const view = await fresh.a.readSession(named);
  assert.deepEqual(view?.messages, corrected.messages);
  assert.deepEqual(view.usage, corrected.usage);
  assert.equal(view.observedTotalTokens, 50);
});

test("equal declared checkpoints with independent message evidence keep the original source names", async t => {
  const fixture = await CollectorApiFixture.open();
  t.after(() => fixture.close());
  const named = { ...source, streamId: "rollout-distinct.jsonl" };
  const legacy = { ...named, streamId: JSON.stringify([scope.root, named.streamId]) };
  const sourceObservation = { ...batch.sourceObservation, location: { ...batch.sourceObservation.location, path: named.streamId } };
  for (const [i, key] of [named, legacy].entries()) {
    assert.equal(await fixture.a.commit({ ...batch, source: key, sourceObservation, expectedVersion: i,
      messages: [{ ...batch.messages[0], id: "distinct-" + i, text: "message " + i }] }), "committed");
  }
  assert.equal((await fixture.a.listSources(scope)).length, 2);
  assert.equal((await fixture.a.readSession(named))?.messages.length, 2);
});
