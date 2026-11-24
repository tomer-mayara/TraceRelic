import assert from "node:assert/strict";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { Batch, CommitResult, SessionView } from "@tracerelic/collector/storage";
import { RewriteScanFixture } from "../../fixtures/rewrite-scan-fixture.ts";
import { rotateCodex } from "../../fixtures/scan-repair-fixture.ts";
import { CodexIdentityRepairFixture } from "../../fixtures/codex-identity-repair-fixture.ts";

interface RewriteScenario {
  identity?: CodexIdentityRepairFixture;
  rewrite: RewriteScanFixture;
  original: SessionView;
  held: Batch;
  delivery: CommitResult;
  moving: Awaited<ReturnType<typeof rotateCodex>>;
}

After({ tags: "@lc06" }, async function (this: RewriteScenario) { await this.identity?.root.close(); });
Given("an older scanner filed a verified prompt under a different native session with independent messages", async function (this: RewriteScenario) {
  this.identity = await CodexIdentityRepairFixture.create();
  await this.identity.legacy();
});
When("the current scanner reads the native session and its accepted prefix", async function (this: RewriteScenario) {
  assert(this.identity);
  await this.identity.scan();
});
Then("the prompt appears only in its native session and the independent messages remain", async function (this: RewriteScenario) {
  assert(this.identity);
  assert.deepEqual(await this.identity.texts("A"), ["belongs to A"]);
  assert.deepEqual(await this.identity.texts("B"), ["belongs to B"]);
});

Before({ tags: "@lc06" }, async function (this: RewriteScenario) { this.rewrite = await RewriteScanFixture.create(); });
After({ tags: "@lc06" }, async function (this: RewriteScenario) { await this.rewrite?.close(); });

Given("a rollout is about to move to its archive beside an independent chat", async function (this: RewriteScenario) {
  this.moving = await rotateCodex(this.rewrite);
});
When("the move happens during the scan", async function (this: RewriteScenario) { await this.moving.scan(); });
Then("both the moved and independent chats are stored", async function (this: RewriteScenario) {
  for (const sessionId of ["healthy", "s"]) assert(await this.moving.store.readSession({ harness: "codex", sessionId }));
});

Given("a writer holds the old checkpoint at byte {int} for a {int}-token call", async function (
  this: RewriteScenario, offset: number, tokens: number,
) {
  await this.rewrite.write([this.rewrite.call("a", tokens)], offset);
  this.original = await this.rewrite.scan();
  assert.equal(this.original.observedTotalTokens, tokens);
  this.held = await this.rewrite.holdAppend(this.rewrite.call("c", 9));
  assert.equal(this.held.expectedOffset, offset);
  assert(this.held.checkpoint.offset > offset);
});

Given("a replacement file contains that identified call and a new {int}-token call", async function (
  this: RewriteScenario, tokens: number,
) {
  const [first] = this.original.usage;
  await this.rewrite.write([this.rewrite.call("a", first.inputTokens), this.rewrite.call("b", tokens)], this.held.expectedOffset);
});

When("a fresh collector accepts the new file through byte {int} and the old writer submits its batch", async function (
  this: RewriteScenario, offset: number,
) {
  await this.rewrite.scan();
  const accepted = await this.rewrite.storage.readCheckpoint(this.rewrite.source);
  assert.equal(accepted.checkpoint?.offset, offset);
  this.delivery = await this.rewrite.storage.commit(this.held);
});

Then("the old writer receives a conflict and the session still has two calls totaling {int}", async function (
  this: RewriteScenario, total: number,
) {
  assert.equal(this.delivery, "conflict");
  const session = await this.rewrite.storage.readSession(this.rewrite.source);
  assert(session);
  assert.equal(session.observedTotalTokens, total);
  assert.equal(session.coverage, "reported");
  assert.equal(session.usage.length, 2);
  assert(session.usage.every(row => row.kind === "call"));
  assert(session.usage.some(row => row.id === this.original.usage[0].id));
});
