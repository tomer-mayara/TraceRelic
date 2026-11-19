import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BeforeAll, Given, Then, When, setWorldConstructor } from "@cucumber/cucumber";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import type {
  CollectorStorage, CommitResult, SessionKey, SessionView,
} from "../../../src/storage/collector-storage.ts";
import { initialPlanningBatch, observation, prompt } from "../../fixtures/collector-storage-fixture.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";

const schemaFile = new URL(
  "../../dist/collector-storage/storage.schema.json", import.meta.resolve("@tracerelic/collector/package.json"),
);
const schema: unknown = JSON.parse(readFileSync(schemaFile, "utf8"));
assert(schema && typeof schema === "object" && "$schema" in schema && typeof schema.$schema === "string");
const contract = new Ajv2020({ formats: fullFormats }).addSchema({ ...schema, $schema: schema.$schema });

function checkWireValue(model: string, value: unknown): void {
  const wireValue: unknown = JSON.parse(JSON.stringify(value));
  assert(contract.validate(`${model}.json`, wireValue), contract.errorsText());
}

class StorageScenario {
  readonly store: CollectorStorage = new InMemoryCollectorStorage();
  batch = initialPlanningBatch();
  readonly source = this.batch.source;
  readonly key: SessionKey = { harness: this.source.harness, sessionId: this.source.sessionId };
  result?: CommitResult;

  async commit(): Promise<void> {
    checkWireValue("Batch", this.batch);
    this.result = await this.store.commit(this.batch);
    checkWireValue("CommitResult", this.result);
  }

  async view(): Promise<SessionView> {
    checkWireValue("SessionKey", this.key);
    const view = await this.store.readSession(this.key);
    assert(view);
    checkWireValue("SessionView", view);
    return view;
  }
}

setWorldConstructor(StorageScenario);

BeforeAll(function () {
  const { batch } = new StorageScenario();
  checkWireValue("Batch", batch);
  const malformed = { ...batch, expectedOffset: -1 };
  assert.equal(contract.validate("Batch.json", malformed), false);
  assert(contract.errors?.some(error => error.instancePath === "/expectedOffset" && error.keyword === "minimum"));
});

Given("an empty remote storage fixture", async function (this: StorageScenario) {
  assert.equal(await this.store.readSession(this.key), null);
  assert.equal(await this.store.readCheckpoint(this.source), null);
});

When("a collector submits the message {string} without usage", async function (this: StorageScenario, text: string) {
  this.batch.messages.push(prompt(text));
  await this.commit();
  assert.equal(this.result, "committed");
});

Then("the session contains {string}", async function (this: StorageScenario, text: string) {
  assert.deepEqual((await this.view()).messages, [prompt(text)]);
});

Then("its token total is unknown", async function (this: StorageScenario) {
  const view = await this.view();
  assert.equal(view.coverage, "unknown");
  assert.equal(view.observedTotalTokens, null);
});

async function recordFirstUsage(this: StorageScenario, input: number, output: number): Promise<void> {
  this.batch.usage = [observation(input, output)];
  await this.commit();
  assert.equal(this.result, "committed");
}

Given("a batch with {int} input tokens and {int} output tokens was stored", recordFirstUsage);
Given("a Claude request reported {int} input tokens and {int} output tokens", recordFirstUsage);

When("a collector retries that batch from its original position", async function (this: StorageScenario) {
  await this.commit();
});

Then("the collector is told to reload its checkpoint", async function (this: StorageScenario) {
  assert.equal(this.result, "conflict");
  checkWireValue("StreamKey", this.source);
  const stored = await this.store.readCheckpoint(this.source);
  checkWireValue("Checkpoint", stored);
  assert.deepEqual(stored, this.batch.checkpoint);
});

When("the same request is revised to {int} input tokens and {int} output tokens", async function (
  this: StorageScenario, input: number, output: number,
) {
  this.batch = {
    ...this.batch, expectedOffset: 100, checkpoint: { offset: 200, parserState: "{}" },
    usage: [observation(input, output, 2)],
  };
  await this.commit();
  assert.equal(this.result, "committed");
});

Then(/^the session (?:still )?contains one usage record totaling (\d+) tokens$/, async function (
  this: StorageScenario, total: string,
) {
  const view = await this.view();
  assert.deepEqual(view.usage, this.batch.usage);
  assert.equal(view.coverage, "reported");
  assert.equal(view.observedTotalTokens, Number(total));
});

When("a batch includes a message and more cached input tokens than input tokens", async function (this: StorageScenario) {
  this.batch.messages.push(prompt("A message in the invalid batch"));
  this.batch.usage = [{ ...observation(4, 2), cacheReadTokens: 5 }];
  await this.commit();
});

Then("the entire batch is rejected", function (this: StorageScenario) {
  assert.equal(this.result, "invalid");
});

Then("the session and its checkpoint are absent", async function (this: StorageScenario) {
  assert.equal(await this.store.readSession(this.key), null);
  assert.equal(await this.store.readCheckpoint(this.source), null);
});
