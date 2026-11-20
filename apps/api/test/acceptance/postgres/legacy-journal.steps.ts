import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { DurableApiFixture, firstBatch, type WorkspaceClients } from "../../fixtures/durable-api-fixture.ts";
import { lc17Journal, seedLc17 } from "../../fixtures/legacy-journal.ts";

interface UpgradeScenario {
  api: DurableApiFixture;
  clients: WorkspaceClients;
}

Given("LC-17 stored a Claude fork with a copied advisor and a later parent message", { timeout: 120_000 }, async function (this: UpgradeScenario) {
  this.api = await DurableApiFixture.open();
  await seedLc17(this.api.databaseUrl, await lc17Journal("claude"), "workspace-a");
});

When("the upgraded API accepts a new chat with {int} tokens", async function (this: UpgradeScenario, tokens: number) {
  this.clients = await this.api.start();
  assert.equal(await this.clients.a.commit(firstBatch(tokens, 70)), "committed");
});

Then("the earlier parent still reports {int} tokens and the child still reports {int}", async function (this: UpgradeScenario, parent: number, child: number) {
  const views = await Promise.all(["P", "C"].map(sessionId => this.clients.a.readSession({ harness: "claude", sessionId })));
  assert.deepEqual(views.map(view => view?.observedTotalTokens), [parent, child]);
});

Then("the new chat reports {int} tokens after an API restart", async function (this: UpgradeScenario, tokens: number) {
  const { a } = await this.api.restart();
  const batch = firstBatch(tokens, 70);
  const view = await a.readSession(batch.source);
  assert.equal(view?.observedTotalTokens, tokens);
  assert.deepEqual(view.messages, batch.messages);
});
