import assert from "node:assert/strict";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { Batch, CollectorStorage, CommitResult } from "@tracerelic/collector/storage";
import { DurableApiFixture, firstBatch, type WorkspaceClients } from "../../fixtures/durable-api-fixture.ts";

interface DurabilityScenario {
  api: DurableApiFixture;
  clients: WorkspaceClients;
  competing: WorkspaceClients;
  writes: Batch[];
  results: CommitResult[];
}

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
