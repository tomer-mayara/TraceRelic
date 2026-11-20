import assert from "node:assert/strict";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { SessionView } from "@tracerelic/collector/storage";
import { CollectorApiFixture } from "../../fixtures/collector-api-fixture.ts";
import { batch, key, source } from "../../fixtures/collector-wire-payloads.ts";

interface WorkspaceScenario {
  api: CollectorApiFixture;
  a: SessionView | null;
  b: SessionView | null;
  reply: Response;
}

Before({ tags: "@lc14" }, async function (this: WorkspaceScenario) { this.api = await CollectorApiFixture.open(); });
After({ tags: "@lc14" }, async function (this: WorkspaceScenario) { await this.api?.close(); });

Given("workspace A has a 130-token session and workspace B is empty", async function (this: WorkspaceScenario) {
  assert.equal(await this.api.a.commit(batch), "committed");
  assert.equal(await this.api.b.readSession(key), null);
});

When("each workspace requests that session through the API", async function (this: WorkspaceScenario) {
  [this.a, this.b] = await Promise.all([this.api.a.readSession(key), this.api.b.readSession(key)]);
});

Then("A reads 130 and B sees no session", function (this: WorkspaceScenario) {
  assert.equal(this.a?.observedTotalTokens, 130);
  assert.equal(this.b, null);
});

Given("a new session has no stored checkpoint", async function (this: WorkspaceScenario) {
  assert.deepEqual(await this.api.expiring.readCheckpoint(source), { version: 0, checkpoint: null });
});

When("a collector submits it with an expired credential", async function (this: WorkspaceScenario) {
  this.api.expireCredential();
  this.reply = await this.api.expiring.post("batches", batch);
});

Then("the API returns an authentication error and stores nothing", async function (this: WorkspaceScenario) {
  assert.equal(this.reply.status, 401);
  assert.equal(this.reply.headers.get("www-authenticate"), "Bearer");
  assert.deepEqual(await this.reply.json(), { error: "unauthorized" });
  assert.deepEqual(await this.api.a.readCheckpoint(source), { version: 0, checkpoint: null });
  assert.equal(await this.api.a.readSession(key), null);
});
