import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { Batch, CollectorStorage, CommitResult } from "@tracerelic/collector/storage";
import { DurableApiFixture, firstBatch, type WorkspaceClients } from "../../fixtures/durable-api-fixture.ts";
import { countProjectionRows } from "../../fixtures/collector-database-write.ts";
import { batch as wireBatch, source as wireSource } from "../../fixtures/collector-wire-payloads.ts";

interface DurabilityScenario {
  api: DurableApiFixture;
  clients: WorkspaceClients;
  competing: WorkspaceClients;
  writes: Batch[];
  results: CommitResult[];
}

Given("I append {int} one-message batches to one session", { timeout: 30_000 }, async function (this: DurabilityScenario, count: number) {
  await countProjectionRows(this.api.databaseUrl, true);
  for (let i = 0; i < count; i++) {
    const offset = i + 1;
    const batch = { ...wireBatch, expectedVersion: i, expectedOffset: i, checkpoint: { ...wireBatch.checkpoint, offset },
      sourceObservation: { ...wireBatch.sourceObservation, observedEnd: offset }, usage: [],
      messages: [{ ...wireBatch.messages[0], id: "m-" + i, sourceOrder: offset }] };
    assert.equal(await this.clients.a.commit(batch), "committed");
  }
});

Then("PostgreSQL has received {int} message projection rows", async function (this: DurabilityScenario, count: number) {
  assert.equal(await countProjectionRows(this.api.databaseUrl), count);
});

When("a fresh API records that the source has disappeared", async function (this: DurabilityScenario) {
  this.clients = await this.api.restart();
  const { version, checkpoint } = await this.clients.a.readCheckpoint(wireSource);
  assert(checkpoint);
  assert.equal(await this.clients.a.recordPresence({ source: wireSource, expectedVersion: version, expectedOffset: checkpoint.offset,
    observedEnd: checkpoint.offset, presence: "missing", location: wireBatch.sourceObservation.location }), "committed");
});

Then("the {int} messages remain and PostgreSQL has received no more message rows", async function (this: DurabilityScenario, count: number) {
  const view = await this.clients.a.readSession(wireSource);
  assert.equal(view?.messages.length, count);
  assert.equal(await countProjectionRows(this.api.databaseUrl), count);
});

async function assertStored(storage: CollectorStorage, batch: Batch, tokens: number) {
  const [session, snapshot] = await Promise.all([storage.readSession(batch.source), storage.readCheckpoint(batch.source)]);
  assert.equal(session?.observedTotalTokens, tokens, "the fresh API must return this workspace's token total");
  assert.deepEqual(session.messages, batch.messages);
  assert.deepEqual(session.usage, batch.usage);
  assert.equal(session.coverage, "reported");
  assert.deepEqual(snapshot, { version: 1, checkpoint: batch.checkpoint });
}

Before({ timeout: 120_000 }, async function (this: DurabilityScenario) {
  this.api = await DurableApiFixture.open();
  this.clients = await this.api.start();
});
After({ timeout: 30_000 }, async function (this: DurabilityScenario) { await this.api?.close(); });

Given("workspace A stored {int} tokens at byte {int} and workspace B stored {int} tokens at byte {int} for the same session",
  async function (this: DurabilityScenario, tokensA: number, endA: number, tokensB: number, endB: number) {
    this.writes = [firstBatch(tokensA, endA), firstBatch(tokensB, endB)];
    const [a, b] = this.writes;
    assert.deepEqual(await Promise.all([this.clients.a.commit(a), this.clients.b.commit(b)]), ["committed", "committed"]);
    await Promise.all([assertStored(this.clients.a, a, tokensA), assertStored(this.clients.b, b, tokensB)]);
  });

const digestAt = (end: number) => createHash("sha256").update(Buffer.alloc(end, 65)).digest("hex");

Given("workspace A accepted {int} bytes and observed a complete suffix through byte {int} before the source disappeared",
  async function (this: DurabilityScenario, accepted: number, end: number) {
    const batch = firstBatch(70, accepted);
    const location = wireBatch.sourceObservation.location;
    batch.checkpoint.prefixDigest = digestAt(accepted);
    batch.sourceObservation = { location, observedEnd: end, observedPrefixDigest: digestAt(end) };
    assert.equal(await this.clients.a.commit(batch), "committed");
    assert.equal(await this.clients.a.recordPresence({ source: batch.source, expectedOffset: accepted, expectedVersion: 1,
      presence: "missing", location, observedEnd: end }), "committed");
  });

Then("workspace A can verify the missing suffix through byte {int} and its checkpoint is still at byte {int}",
  async function (this: DurabilityScenario, end: number, accepted: number) {
    const source = firstBatch(70, accepted).source;
    const snapshot = await this.clients.a.readCheckpoint(source);
    assert.equal(snapshot.checkpoint?.offset, accepted);
    assert.deepEqual(snapshot.observedThrough, { offset: end, prefixDigest: digestAt(end) });
    const view = await this.clients.a.readSession(source);
    assert.equal(view?.coverage, "partial");
    assert.equal(view.observedTotalTokens, 70);
  });

When("I restart the API with a new connection to the same database", async function (this: DurabilityScenario) {
  this.clients = await this.api.restart();
});

Then("workspace A reads {int} tokens at byte {int} and workspace B reads {int} tokens at byte {int}",
  async function (this: DurabilityScenario, tokensA: number, endA: number, tokensB: number, endB: number) {
    await Promise.all([assertStored(this.clients.a, firstBatch(tokensA, endA), tokensA),
      assertStored(this.clients.b, firstBatch(tokensB, endB), tokensB)]);
  });

Given(/^two workers read version zero for (the same source|different sources in the same session)$/, async function (
  this: DurabilityScenario, sources: string,
) {
  this.competing = await this.api.start();
  this.writes = [firstBatch(120, 420, "first"), firstBatch(9, 70, "second")];
  if (sources === "different sources in the same session") this.writes[1].source.streamId = "second.jsonl";
  const checkpoints = await Promise.all([this.clients.a.readCheckpoint(this.writes[0].source),
    this.competing.a.readCheckpoint(this.writes[1].source)]);
  for (const checkpoint of checkpoints) assert.deepEqual(checkpoint, { version: 0, checkpoint: null });
});

When("they submit different first batches through independent database connections", async function (this: DurabilityScenario) {
  this.results = await Promise.all([this.clients.a.commit(this.writes[0]), this.competing.a.commit(this.writes[1])]);
});

Then("one worker sees committed and the other sees conflict", async function (this: DurabilityScenario) {
  assert.deepEqual([...this.results].sort(), ["committed", "conflict"]);
  const metrics = await Promise.all([this.clients.nextCommitMetric(), this.competing.nextCommitMetric()]);
  assert.deepEqual(metrics.map(event => event.outcome), this.results);
});

Then("a new reader sees only the winner's records and checkpoint", async function (this: DurabilityScenario) {
  const fresh = await this.api.start();
  const winner = this.writes[this.results.indexOf("committed")];
  await assertStored(fresh.a, winner, winner.usage[0].inputTokens);
});

Then("the losing source sees the winner's version and has no checkpoint", async function (this: DurabilityScenario) {
  const fresh = await this.api.start();
  const winner = this.writes[this.results.indexOf("committed")];
  const loser = this.writes[this.results.indexOf("conflict")];
  await assertStored(fresh.a, winner, winner.usage[0].inputTokens);
  assert.deepEqual(await fresh.a.readCheckpoint(loser.source), { version: 1, checkpoint: null });
});

When("the losing worker reloads and retries its call once", async function (this: DurabilityScenario) {
  const index = this.results.indexOf("conflict");
  const worker = [this.clients.a, this.competing.a][index];
  const batch = this.writes[index];
  const { version, checkpoint } = await worker.readCheckpoint(batch.source);
  assert.equal(await worker.commit({ ...batch, expectedVersion: version, expectedOffset: checkpoint?.offset ?? 0 }), "committed");
});

Then("a new reader sees both calls once and both source checkpoints at version 2", async function (this: DurabilityScenario) {
  const fresh = await this.api.start();
  const session = await fresh.a.readSession(this.writes[0].source);
  assert.ok(session);
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  assert.deepEqual(session.messages.sort(byId), this.writes.flatMap(batch => batch.messages).sort(byId));
  assert.deepEqual(session.usage.sort(byId), this.writes.flatMap(batch => batch.usage).sort(byId));
  assert.equal(session.observedTotalTokens, 129);
  for (const batch of this.writes) {
    assert.deepEqual(await fresh.a.readCheckpoint(batch.source), { version: 2, checkpoint: batch.checkpoint });
  }
});
