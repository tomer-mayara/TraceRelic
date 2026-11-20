import assert from "node:assert/strict";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import { LostConnectionFixture, type DropMoment } from "../../fixtures/lost-connection-fixture.ts";
import { scanContract } from "../../fixtures/scan-contract.ts";

interface ConnectionScenario {
  upload: LostConnectionFixture;
}

Before({ tags: "@lc08" }, async function (this: ConnectionScenario) { this.upload = await LostConnectionFixture.create(); });
After({ tags: "@lc08" }, async function (this: ConnectionScenario) { await this.upload?.close(); });

Given("storage holds a {int}-token call and the source contains one more call of {int}", async function (
  this: ConnectionScenario, first: number, second: number,
) {
  await this.upload.prepare(first, second);
});

When(/^the connection drops (before storage writes|after storage writes) and I scan again after reconnecting$/, async function (
  this: ConnectionScenario, moment: DropMoment,
) {
  const { connection, transcript, firstEnd, secondEnd } = this.upload;
  connection.dropNextWrite(moment);
  await assert.rejects(transcript.scan(connection), error => {
    assert(error instanceof Error && "pending" in error, "scan --once must report an unresolved write as pending");
    const pending = error.pending;
    assert(scanContract.validate("PendingScan.json", pending), scanContract.errorsText());
    assert(pending && typeof pending === "object" && "retryAt" in pending && typeof pending.retryAt === "string");
    assert.deepEqual(pending, { status: "pending", reason: "storage-unavailable", source: transcript.source,
      byteRange: { startOffset: firstEnd, endOffset: secondEnd }, retryAt: new Date(pending.retryAt).toISOString() });
    assert.doesNotMatch(error.message + JSON.stringify(pending), /private (transcript|transport) detail/);
    return true;
  });
  assert(connection.checkedWhileOffline, "the scanner must check storage after losing a write");
  const accepted = moment === "after storage writes";
  await this.upload.checkStored(accepted ? 2 : 1, accepted ? 150 : 120);
  connection.reconnect();
  await transcript.scan(connection);
  assert.equal(connection.writes, accepted ? 2 : 3);
});

Then("I can read two calls totaling {int} and the checkpoint is at the end of the new call", async function (
  this: ConnectionScenario, total: number,
) {
  const session = await this.upload.checkStored(2, total);
  const writes = this.upload.connection.writes;
  assert.deepEqual(await this.upload.transcript.scan(this.upload.connection), session);
  assert.equal(this.upload.connection.writes, writes);
  assert.deepEqual(await this.upload.checkStored(2, total), session);
});
