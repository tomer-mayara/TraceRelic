import assert from "node:assert/strict";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import { ScanRejectedError } from "@tracerelic/collector/scan";
import { RejectedBatchFixture } from "../../fixtures/rejected-batch-fixture.ts";
import { scanContract } from "../../fixtures/scan-contract.ts";

interface RejectedScenario {
  rejected: RejectedBatchFixture;
  before: Awaited<ReturnType<RejectedBatchFixture["prepare"]>>;
  error: unknown;
}

Before({ tags: "@lc09" }, async function (this: RejectedScenario) { this.rejected = await RejectedBatchFixture.create(); });
After({ tags: "@lc09" }, async function (this: RejectedScenario) { await this.rejected?.close(); });

Given("source A changes the stored text {string} under the same ID and source B has a {int}-token call", async function (
  this: RejectedScenario, text: string, tokens: number,
) {
  this.before = await this.rejected.prepare(text, tokens);
});

When("I scan both sources", async function (this: RejectedScenario) {
  try { await this.rejected.scan(); } catch (error) { this.error = error; }
});

Then("A keeps {string} and its previous checkpoint", async function (this: RejectedScenario, text: string) {
  const a = await this.rejected.storage.readSession(this.rejected.a);
  assert.deepEqual(a?.messages.map(row => row.text), [text]);
  assert.deepEqual(a, this.before.original);
  assert.deepEqual(await this.rejected.storage.readCheckpoint(this.rejected.a), this.before.checkpoint);
});

Then("B shows {int} tokens and the scan identifies A's rejected range", async function (this: RejectedScenario, tokens: number) {
  const b = await this.rejected.storage.readSession(this.rejected.b);
  assert.equal(b?.observedTotalTokens, tokens, "the healthy source must commit after A is rejected");
  assert(this.error instanceof ScanRejectedError);
  const { sessions, rejections } = this.error;
  assert(scanContract.validate("RejectedScan.json", { sessions, rejections }), scanContract.errorsText());
  assert.deepEqual(sessions, [this.before.original, b]);
  assert.deepEqual(rejections, [{ status: "rejected", source: this.rejected.a, byteRange: this.before.byteRange }]);
});
