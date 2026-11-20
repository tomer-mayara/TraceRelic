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

Given("two workers read version zero for the same source", async function (this: DurabilityScenario) {
  this.competing = await this.api.start();
  this.writes = [firstBatch(120, 420, "first"), firstBatch(9, 70, "second")];
  const { source } = this.writes[0];
  for (const storage of [this.clients.a, this.competing.a]) {
    assert.deepEqual(await storage.readCheckpoint(source), { version: 0, checkpoint: null });
  }
});

When("they submit different first batches through independent database connections", async function (this: DurabilityScenario) {
  this.results = await Promise.all([this.clients.a.commit(this.writes[0]), this.competing.a.commit(this.writes[1])]);
});

Then("one worker sees committed and the other sees conflict", function (this: DurabilityScenario) {
  assert.deepEqual([...this.results].sort(), ["committed", "conflict"]);
});

Then("a new reader sees only the winner's records and checkpoint", async function (this: DurabilityScenario) {
  const fresh = await this.api.start();
  const winner = this.writes[this.results.indexOf("committed")];
  await assertStored(fresh.a, winner, winner.usage[0].inputTokens);
});
