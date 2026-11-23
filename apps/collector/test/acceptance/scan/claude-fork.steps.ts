import assert from "node:assert/strict";
import { After, Given, When } from "@cucumber/cucumber";
import { ClaudeHistory } from "@tracerelic/collector/providers";
import { ClaudeForkScanFixture } from "../../fixtures/claude-fork-scan-fixture.ts";
import { scanContract } from "../../fixtures/scan-contract.ts";
import type { ForkTotalsScenario } from "./fork-totals.steps.ts";

interface ClaudeForkScenario extends ForkTotalsScenario {
  forks: ClaudeForkScanFixture[];
  snapshots: Awaited<ReturnType<ClaudeForkScanFixture["snapshot"]>>[];
}

After({ tags: "@lc11" }, async function (this: ClaudeForkScenario) {
  await Promise.all((this.forks ?? []).map(f => f.close()));
});

Given(/^a Claude parent used (\d+) tokens and its (fork with new transcript UUIDs|subagent with the parent ID) copies that call$/, async function (
  this: ClaudeForkScenario, tokens: string, child: string,
) {
  const kind = child === "subagent with the parent ID" ? "subagent" : "fork";
  this.forks = [];
  for (let i = 0; i < 2; i++) {
    const fixture = await ClaudeForkScanFixture.create(kind);
    this.forks.push(fixture);
    await fixture.writeParent(Number(tokens));
    await fixture.writeCopy(Number(tokens));
  }
});

Given("the child makes a separate {int}-token call", async function (this: ClaudeForkScenario, tokens: number) {
  for (const fixture of this.forks) await fixture.appendOwn(tokens);
});

Given("a parent reports a provisional {int}-token request", async function (this: ClaudeForkScenario, tokens: number) {
  this.forks = [];
  for (let i = 0; i < 2; i++) {
    const fixture = await ClaudeForkScanFixture.create("fork");
    this.forks.push(fixture);
    await fixture.writeParent(tokens, { provisional: true });
  }
});

Given("its fork reports a final {int}-token executor and a new {int}-token advisor for that request", async function (
  this: ClaudeForkScenario, executor: number, advisorTokens: number,
) {
  for (const fixture of this.forks) await fixture.writeCopy(executor, { advisorTokens });
});

When("I collect both transcripts in either order", async function (this: ClaudeForkScenario) {
  this.snapshots = [];
  for (const [index, fixture] of this.forks.entries()) {
    const home = fixture.roots.child.home;
    const [source] = await Array.fromAsync(new ClaudeHistory(home).discoverSources());
    assert(scanContract.validate("ClaudeTranscriptSource.json", source), scanContract.errorsText());
    const order = index === 0 ? ["parent", "child"] as const : ["child", "parent"] as const;
    await fixture.scan(order[0]);
    if (order[0] === "child") {
      const pending = await fixture.storage.readSession(fixture.child);
      assert(scanContract.validate("SessionView.json", pending), scanContract.errorsText());
    }
    await fixture.scan(order[1]);
    const first = await fixture.snapshot();
    for (const site of order) await fixture.scan(site);
    assert.deepEqual(await fixture.snapshot(), first);
    this.snapshots.push(first);
  }
  this.checkForkTotals = (parentTokens, childTokens) => checkTotals(this.snapshots, parentTokens, childTokens);
});

function checkTotals(snapshots: ClaudeForkScenario["snapshots"], parentTokens: number, childTokens: number) {
  for (const { parent, child } of snapshots) {
    assert.equal(parent.observedTotalTokens, parentTokens);
    assert.equal(child.observedTotalTokens, childTokens, "only the child's independent call belongs in its total");
    assert.equal(child.metadata.parentSessionId, "parent");
    assert.equal(child.coverage, "reported");
    assert.deepEqual(parent.messages.map(row => row.text), ["Inherited answer"]);
    assert.deepEqual(child.messages.map(row => row.text), ["Inherited answer", "Child answer"]);
    assert.deepEqual([...new Set(parent.usage.map(row => row.requestId))], ["parent-request"]);
    assert.deepEqual(child.usage.map(row => row.requestId), ["child-request-helper"]);
    for (const view of [child, parent]) assert(scanContract.validate("SessionView.json", view), scanContract.errorsText());
  }
}
