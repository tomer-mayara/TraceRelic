import assert from "node:assert/strict";
import { unlink, writeFile } from "node:fs/promises";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import { RemoteSyncFixture } from "../../fixtures/remote-sync-fixture.ts";
import type { DropMoment } from "../../fixtures/loopback-upload-relay.ts";

interface RemoteSyncScenario { sync: RemoteSyncFixture; initialRequests: number }

async function setInstallation({ sync }: RemoteSyncScenario, spelling: string) {
  const { transcript } = sync.upload;
  await writeFile(transcript.config, JSON.stringify({ codexPath: transcript.root.home,
    ...(spelling === "named" && { installationId: "desktop" }) }));
}

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

Given("a transcript containing {int} distinct small Codex calls", async function (this: RemoteSyncScenario, count: number) {
  const { transcript } = this.sync.upload;
  await transcript.write(Array.from({ length: count }, (_, i) => transcript.call("call-" + i, 1)));
});

When("I upload the transcript and restart the scanner to append one more call", { timeout: 40_000 }, async function (this: RemoteSyncScenario) {
  const { transcript } = this.sync.upload;
  const first = await this.sync.scan();
  assert.equal(first.code, 0, first.stderr);
  this.initialRequests = this.sync.relay.batches;
  await transcript.append(transcript.call("last", 1));
  const next = await this.sync.scan();
  assert.equal(next.code, 0, next.stderr);
});

Then("the remote session contains {int} calls and each request fits in one MiB", async function (this: RemoteSyncScenario, count: number) {
  const { transcript, storage } = this.sync.upload;
  const session = await storage.readSession(transcript.source);
  assert.equal(session?.usage.length, count);
  assert.equal(session.observedTotalTokens, count);
  assert(this.sync.relay.largestUpload <= 1_048_576);
});

Given(/^I uploaded one transcript with the installation (omitted|named)$/, async function (this: RemoteSyncScenario, spelling: string) {
  const { transcript } = this.sync.upload;
  await transcript.write([transcript.call("one", 10)]);
  await setInstallation(this, spelling);
  assert.equal((await this.sync.scan()).code, 0);
});

When(/^I scan again with the installation (omitted|named) and then remove the transcript$/, async function (this: RemoteSyncScenario, spelling: string) {
  await setInstallation(this, spelling);
  assert.equal((await this.sync.scan()).code, 0);
  await unlink(this.sync.upload.transcript.file);
});

Then("one checkpoint and one disappearance identify the transcript", async function (this: RemoteSyncScenario) {
  const { transcript, storage } = this.sync.upload;
  const result = await this.sync.scan();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr.trim().split("\n").length, 1);
  assert.equal((await storage.listSources({ harness: "codex", root: transcript.root.home })).length, 1);
  assert.equal((await storage.readSession(transcript.source))?.missingSources?.length, 1);
});

Then("the one-call append needs one upload smaller than {int} KiB", function (this: RemoteSyncScenario, kibibytes: number) {
  assert.equal(this.sync.relay.batches - this.initialRequests, 1);
  assert(this.sync.relay.lastUpload < kibibytes * 1024);
});
