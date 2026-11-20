import assert from "node:assert/strict";
import { After, Before, Given, When } from "@cucumber/cucumber";
import { CodexForkScanFixture } from "../../fixtures/codex-fork-scan-fixture.ts";
import { scanContract } from "../../fixtures/scan-contract.ts";
import type { ForkTotalsScenario } from "./fork-totals.steps.ts";

interface ForkScenario extends ForkTotalsScenario {
  fork: CodexForkScanFixture;
  seen: Awaited<ReturnType<CodexForkScanFixture["scan"]>>;
  progress: Awaited<ReturnType<CodexForkScanFixture["checkpoints"]>>;
  source: Awaited<ReturnType<CodexForkScanFixture["writeChild"]>>;
}

Before({ tags: "@lc10" }, async function (this: ForkScenario) {
  this.fork = await CodexForkScanFixture.create();
  this.checkForkTotals = checkCodexTotals;
});
After({ tags: "@lc10" }, async function (this: ForkScenario) { await this.fork?.close(); });

Given("a Codex parent had {int} tokens at the fork and now has {int}", async function (
  this: ForkScenario, forked: number, current: number,
) {
  await this.fork.writeParent(forked, current);
});

Given("the child copied the prefix of {int} and its next cumulative total is {int}", async function (
  this: ForkScenario, forked: number, current: number,
) {
  this.source = await this.fork.writeChild(forked, current);
});

When("I discover the child before the archived parent and scan twice", async function (this: ForkScenario) {
  const sources = await this.fork.discover();
  assert.deepEqual(sources.map(source => source.sessionId), ["child", "parent"]);
  for (const source of sources) assert(scanContract.validate("TranscriptSourceInfo.json", source), scanContract.errorsText());
  this.seen = await this.fork.scan();
  this.progress = await this.fork.checkpoints();
  assert.deepEqual(await this.fork.scan(), this.seen);
  assert.deepEqual(await this.fork.checkpoints(), this.progress);
});

When(/^the parent is available as (only its shorter prefix|both full and short files) and I scan again$/, async function (
  this: ForkScenario, copies: string,
) {
  const before = this.progress.child;
  await this.fork.shortenParent(copies === "both full and short files");
  this.seen = await this.fork.scan();
  this.progress = await this.fork.checkpoints();
  assert.deepEqual(this.progress.child, before);
});

function checkCodexTotals(this: ForkScenario, parentTokens: number, childTokens: number) {
  assert.equal(this.seen.length, 2);
  const child = this.seen.find(view => view.key.sessionId === "child");
  const parent = this.seen.find(view => view.key.sessionId === "parent");
  assert(parent && child);
  assert.equal(parent.observedTotalTokens, parentTokens);
  assert.equal(child.observedTotalTokens, childTokens, "the child must exclude the copied prefix");
  assert.equal(child.metadata.parentSessionId, parent.key.sessionId);
  assert.equal(child.coverage, "reported");
  assert.deepEqual(child.messages.map(row => row.text), ["Inherited plan", "Child plan"]);
  assert.deepEqual(parent.messages.map(row => row.text), ["Inherited plan"]);
  assert.deepEqual(child.usage.filter(row => row.kind === "call").map(row => row.requestId), ["child-request"]);
  assert(parent.usage.some(row => row.requestId === "parent-request"));
  assert.partialDeepStrictEqual(this.progress.child.checkpoint, {
    codexFork: { parentSessionId: "parent", inheritedThrough: this.source.inheritedThrough, baseline: this.source.baseline },
  });
  for (const view of [parent, child]) assert(scanContract.validate("SessionView.json", view), scanContract.errorsText());
  assert(scanContract.validate("CheckpointSnapshot.json", this.progress.child), scanContract.errorsText());
}
