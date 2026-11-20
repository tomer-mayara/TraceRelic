import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import { MissingSourceFixture } from "../../fixtures/missing-source-fixture.ts";
import { scanContract } from "../../fixtures/scan-contract.ts";
import { rotateClaude, unacceptedAppend } from "../../fixtures/scan-repair-fixture.ts";

interface MissingSourceScenario {
  file: MissingSourceFixture;
  end: number;
  before: Awaited<ReturnType<MissingSourceFixture["acknowledge"]>>;
  views: Awaited<ReturnType<MissingSourceFixture["scan"]>>;
  offline: Awaited<ReturnType<typeof unacceptedAppend>>;
  rotation: Awaited<ReturnType<typeof rotateClaude>>;
}

Before({ tags: "@lc12" }, async function (this: MissingSourceScenario) { this.file = await MissingSourceFixture.create(); });
After({ tags: "@lc12" }, async function (this: MissingSourceScenario) { await this.file?.close(); });

Given("a measured rollout has a known unaccepted append and a later offline checkpoint read", async function (this: MissingSourceScenario) {
  this.offline = await unacceptedAppend(this.file);
});
When("the rollout disappears before storage reconnects", async function (this: MissingSourceScenario) {
  this.views = await this.offline.disappear();
});
Then("the missing report includes the complete append and the measured coverage is partial", function (this: MissingSourceScenario) {
  assert.deepEqual(this.file.reports, [this.file.missing(this.offline.accepted, this.offline.end)]);
  assert.equal(this.views[0].coverage, "partial");
  assert.equal(this.views[0].observedTotalTokens, 70);
});
Given("an accepted Claude transcript gains an anonymous message before it is renamed to a backup", async function (this: MissingSourceScenario) {
  this.rotation = await rotateClaude(this.file);
});
When("I scan twice with only the backup present", async function (this: MissingSourceScenario) {
  this.views = await this.file.scan(this.rotation.args);
  assert.deepEqual(await this.file.scan(this.rotation.args), this.views);
});
Then("the anonymous continuation appears once under the original session", function (this: MissingSourceScenario) {
  assert.deepEqual(this.views[0].messages.map(message => message.text), this.rotation.texts);
});

Given("this installation acknowledged {int} tokens through byte {int} and saw complete data through {int}", async function (
  this: MissingSourceScenario, tokens: number, accepted: number, end: number,
) {
  this.before = await this.file.acknowledge(tokens, accepted, end);
  this.end = end;
});

When("a fresh collector successfully scans all possible locations twice and the file is absent", async function (this: MissingSourceScenario) {
  const { source, storage, file } = this.file.transcript;
  await rm(file);
  this.views = await this.file.scan();
  const missing = await storage.readCheckpoint(source);
  assert.deepEqual(await this.file.scan(), this.views);
  assert.deepEqual(await storage.readCheckpoint(source), missing);
  assert.deepEqual(missing.checkpoint, this.before.checkpoint);
  assert.equal(missing.version, this.before.version + 1);
});

Then("it reports one missing source at {int} and the total stays {int} with {word} coverage", function (
  this: MissingSourceScenario, accepted: number, tokens: number, coverage: string,
) {
  const expected = this.file.missing(accepted, this.end);
  assert.deepEqual(this.file.reports, [expected]);
  assert(scanContract.validate("MissingSource.json", this.file.reports[0]), scanContract.errorsText());
  assert.equal(this.views.length, 1);
  const [view] = this.views;
  assert(scanContract.validate("SessionView.json", view), scanContract.errorsText());
  assert.deepEqual(view.missingSources, [expected]);
  assert.equal(view.observedTotalTokens, tokens);
  assert.equal(view.coverage, coverage);
  assert.equal(view.usage.length, 1);
});
