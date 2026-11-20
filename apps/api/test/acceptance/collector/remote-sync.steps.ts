import assert from "node:assert/strict";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import { RemoteSyncFixture } from "../../fixtures/remote-sync-fixture.ts";
import type { DropMoment } from "../../fixtures/loopback-upload-relay.ts";

interface RemoteSyncScenario { sync: RemoteSyncFixture }

Before({ tags: "@lc15" }, async function (this: RemoteSyncScenario) { this.sync = await RemoteSyncFixture.open(); });
After({ tags: "@lc15" }, async function (this: RemoteSyncScenario) { await this.sync?.close(); });

Given("the collector API holds a {int}-token call and my transcript has another call of {int}", async function (
  this: RemoteSyncScenario, first: number, second: number,
) {
  await this.sync.upload.prepare(first, second, () => this.sync.scanAndRead());
  await this.sync.upload.checkStored(1, first);
});

When(/^the connection drops (before the API receives the upload|after the API accepts the upload) and I restart the scanner against the same API$/,
  async function (this: RemoteSyncScenario, moment: DropMoment) {
    const { relay, upload } = this.sync;
    relay.dropNextBatch(moment);
    const interrupted = await this.sync.scan();
    assert.equal(interrupted.code, 75, interrupted.stderr);
    assert.equal(interrupted.stdout, "");
    const pending: unknown = JSON.parse(interrupted.stderr);
    assert(pending && typeof pending === "object" && "retryAt" in pending && typeof pending.retryAt === "string");
    assert.deepEqual(pending, {
      status: "pending", reason: "storage-unavailable", source: upload.transcript.source,
      byteRange: { startOffset: upload.firstEnd, endOffset: upload.secondEnd }, retryAt: new Date(pending.retryAt).toISOString(),
    });
    assert(relay.checkedWhileOffline, "the scanner must try to read the accepted checkpoint after losing the connection");
    const accepted = moment === "after the API accepts the upload";
    await upload.checkStored(accepted ? 2 : 1, accepted ? 150 : 120);
    relay.reconnect();
    await this.sync.scanAndRead();
    assert.equal(relay.batches, accepted ? 2 : 3);
  });

Then("an authenticated read returns two calls totaling {int} and a checkpoint covering both", async function (
  this: RemoteSyncScenario, total: number,
) {
  const { relay, upload } = this.sync;
  const stored = await upload.checkStored(2, total);
  const writes = relay.batches;
  assert.deepEqual(await this.sync.scanAndRead(), stored);
  assert.deepEqual(await upload.checkStored(2, total), stored);
  assert.equal(relay.batches, writes);
});
