import assert from "node:assert/strict";
import { After, Given, Then, When } from "@cucumber/cucumber";
import type { SessionView } from "@tracerelic/collector/storage";
import { ClaudeCopyMetadataFixture } from "../../fixtures/claude-copy-metadata-fixture.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";

interface Scenario {
  copyMetadata?: ClaudeCopyMetadataFixture;
  metadataStore: InMemoryCollectorStorage;
  beforeMetadataRepair: SessionView;
  afterMetadataRepair: SessionView[];
}

Given("an older scanner accepted a current working directory and filled a missing repository from a superseded file", async function (this: Scenario) {
  this.copyMetadata = await ClaudeCopyMetadataFixture.create();
  this.metadataStore = new InMemoryCollectorStorage();
  await this.copyMetadata.seed(this.metadataStore);
  const before = await this.metadataStore.readSession(this.copyMetadata.key);
  assert(before);
  this.beforeMetadataRepair = before;
});

When("a fresh collector rescans their checkpoints twice", async function (this: Scenario) {
  assert(this.copyMetadata);
  this.afterMetadataRepair = await this.copyMetadata.scan(this.metadataStore);
  assert.deepEqual(await this.copyMetadata.scan(this.metadataStore), this.afterMetadataRepair);
});

Then("the original working directory, fallback repository, branch and messages are preserved", function (this: Scenario) {
  assert.deepEqual(this.beforeMetadataRepair.metadata, {
    cwd: "/current", repository: "first backup value", branch: "current-branch", parentSessionId: "current-parent",
  });
  assert.deepEqual(this.afterMetadataRepair, [this.beforeMetadataRepair]);
});

After(async function (this: Scenario) { await this.copyMetadata?.close(); });
