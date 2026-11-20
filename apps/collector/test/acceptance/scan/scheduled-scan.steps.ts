import assert from "node:assert/strict";
import { After, Given, Then, When } from "@cucumber/cucumber";
import { ScanCommandFixture } from "../../fixtures/scan-command-fixture.ts";
import { scanContract } from "../../fixtures/scan-contract.ts";
import { ScheduledScanFixture } from "../../fixtures/scheduled-scan-fixture.ts";

interface ScheduledScanScenario {
  files: ScanCommandFixture;
  watch: ScheduledScanFixture;
}

After({ tags: "@lc13" }, async function (this: ScheduledScanScenario) {
  try {
    await this.watch?.stop();
  } finally {
    await this.files?.close();
  }
});

Given("the startup scan finished and a new planning chat appears before the next interval", async function (this: ScheduledScanScenario) {
  this.files = await ScanCommandFixture.create();
  await this.files.configure();
  this.watch = new ScheduledScanFixture(this.files.storage, ["--config", this.files.configFile]);
  await this.watch.waitForPass();
  assert.deepEqual(this.watch.reports.map(report => report.newSessions), [0]);
  await this.files.writePlanningChat();
  await this.watch.advance(this.watch.intervalMs - 1);
  assert.equal(this.watch.reports.length, 1);
  assert.equal(await this.files.storage.readSession(this.files.codexKey), null);
});

When("the next interval elapses", async function (this: ScheduledScanScenario) {
  await this.watch.advance(1);
});

Then("the chat is readable and the scan reports one new session", async function (this: ScheduledScanScenario) {
  const { storage, codexKey, codexMessages } = this.files;
  const session = await storage.readSession(codexKey);
  assert(session);
  assert(scanContract.validate("SessionView.json", session), scanContract.errorsText());
  assert.deepEqual(session.messages.map(({ at, role, text }) => ({ at, role, text })), codexMessages);
  await this.watch.advance();
  assert.deepEqual(await storage.readSession(codexKey), session);
  assert.deepEqual(this.watch.reports, [0, 1, 0].map(newSessions => ({ status: "complete", newSessions, oldestPendingAgeMs: null })));
  for (const report of this.watch.reports) assert(scanContract.validate("ScheduledScanReport.json", report), scanContract.errorsText());
});
