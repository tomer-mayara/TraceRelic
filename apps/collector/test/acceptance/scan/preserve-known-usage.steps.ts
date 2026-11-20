import assert from "node:assert/strict";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { SessionView } from "../../../src/storage/collector-storage.ts";
import { CodexRolloutFixture } from "../../fixtures/codex-rollout-fixture.ts";
import { RewriteScanFixture } from "../../fixtures/rewrite-scan-fixture.ts";
import { scanContract } from "../../fixtures/scan-contract.ts";
import { appendTranscriptBytes } from "../../fixtures/transcript-gap-fixture.ts";

interface GapScenario {
  rollout: RewriteScanFixture;
  damaged: Awaited<ReturnType<typeof appendTranscriptBytes>>;
  result: SessionView;
}

Before({ tags: "@lc07" }, async function (this: GapScenario) { this.rollout = await RewriteScanFixture.create(); });
After({ tags: "@lc07" }, async function (this: GapScenario) { await this.rollout?.close(); });

Given("a session has a known {int}-token call followed by a malformed complete line", async function (this: GapScenario, tokens: number) {
  await this.rollout.write([this.rollout.call("known", tokens)]);
  const known = await this.rollout.scan();
  assert.equal(known.observedTotalTokens, tokens);
  assert.equal(known.coverage, "reported");
  this.damaged = await appendTranscriptBytes(this.rollout.file, '{"private":"café"\r\n');
});

When("I read the next message {string} and a distinct {int}-token call", async function (this: GapScenario, text: string, tokens: number) {
  await this.rollout.append(CodexRolloutFixture.message(this.rollout.header.timestamp, text));
  await this.rollout.append(this.rollout.call("later", tokens));
  this.result = await this.rollout.scan();
});

Then("{string} is present and the partial total is {int}", function (this: GapScenario, text: string, total: number) {
  assert.deepEqual(this.result.messages.map(message => message.text), [text]);
  assert.equal(this.result.observedTotalTokens, total);
  assert.equal(this.result.usage.length, 2);
  assert.equal(this.result.coverage, "partial");
});

Then("the report identifies the damaged byte range", async function (this: GapScenario) {
  const { streamId, installationId } = this.rollout.source;
  assert.deepEqual(this.result.usageDiagnostics, [{
    code: "malformed-transcript-line", streamId, installationId, sourceOrder: 3, byteRange: this.damaged,
  }]);
  assert(scanContract.validate("SessionView.json", this.result), scanContract.errorsText());
  const snapshot = await this.rollout.storage.readCheckpoint(this.rollout.source);
  assert(snapshot.checkpoint);
  assert(scanContract.validate("CheckpointSnapshot.json", snapshot), scanContract.errorsText());
  const state: unknown = JSON.parse(snapshot.checkpoint.parserState);
  assert(scanContract.validate("ParserCheckpointState.json", state), scanContract.errorsText());
  assert.partialDeepStrictEqual(state, { version: 4 });
});
