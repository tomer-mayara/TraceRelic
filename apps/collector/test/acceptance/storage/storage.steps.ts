import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BeforeAll, Given, Then, When, setWorldConstructor } from "@cucumber/cucumber";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import type {
  Batch, CheckpointSnapshot, CollectorStorage, CommitResult, SessionKey, SessionView,
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
  secondBatch?: Batch;
  result?: CommitResult;

  async commit(batch = this.batch): Promise<void> {
    checkWireValue("Batch", batch);
    this.result = await this.store.commit(batch);
    checkWireValue("CommitResult", this.result);
  }

  async readCheckpoint(source = this.source): Promise<CheckpointSnapshot> {
    checkWireValue("StreamKey", source);
    const snapshot = await this.store.readCheckpoint(source);
    checkWireValue("CheckpointSnapshot", snapshot);
    return snapshot;
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
  for (const field of ["expectedVersion", "expectedOffset"] as const) {
    const incomplete: Partial<Batch> = { ...batch };
    delete incomplete[field];
    assert.equal(contract.validate("Batch.json", incomplete), false, field);
    assert(contract.errors?.some(error => error.params.missingProperty === field), contract.errorsText());
  }
  for (const invalid of [null, { checkpoint: null }, { version: 0 }, { version: -1, checkpoint: null }]) {
    assert.equal(contract.validate("CheckpointSnapshot.json", invalid), false, JSON.stringify(invalid));
  }
  const message = prompt("Plan");
  const malformed: [Partial<Batch>, string][] = [
    [{ expectedVersion: -1 }, "/expectedVersion"],
    [{ expectedVersion: 0.5 }, "/expectedVersion"],
    [{ expectedVersion: Number.MAX_SAFE_INTEGER + 1 }, "/expectedVersion"],
    [{ expectedOffset: -1 }, "/expectedOffset"],
    [{ source: { ...batch.source, installationId: "" } }, "/source/installationId"],
    [{ messages: [{ ...message, sourceOrder: 0 }] }, "/messages/0/sourceOrder"],
    [{ messages: [{ ...message, sourceOrder: Number.MAX_SAFE_INTEGER + 1 }] }, "/messages/0/sourceOrder"],
    [{ messages: [{ ...message, blockIndex: -1 }] }, "/messages/0/blockIndex"],
    [{ messages: [{ ...message, turnId: "" }] }, "/messages/0/turnId"],
    [{ messages: [{ ...message, requestId: "" }] }, "/messages/0/requestId"],
    [{ messages: [{ ...message, context: { parentSessionId: "" } }] }, "/messages/0/context/parentSessionId"],
    [{ metadata: { branch: "topic" }, branchObservation: { at: message.at, sourceOrder: 0 } }, "/branchObservation/sourceOrder"],
    [{ metadata: { branch: "topic" }, branchObservation: { at: "today", sourceOrder: 1 } }, "/branchObservation/at"],
  ];
  for (const [fields, path] of malformed) {
    assert.equal(contract.validate("Batch.json", { ...batch, ...fields }), false, path);
    assert(contract.errors?.some(error => error.instancePath === path), contract.errorsText());
  }
});

Given("an empty remote storage fixture", async function (this: StorageScenario) {
  assert.deepEqual(await this.readCheckpoint(), { version: 0, checkpoint: null });
  assert.equal(await this.store.readSession(this.key), null);
});

When("a collector submits the message {string} without usage", async function (this: StorageScenario, text: string) {
  const message = prompt(text);
  this.batch.messages.push(message);
  this.batch.metadata = { branch: "topic" };
  this.batch.branchObservation = { at: message.at, sourceOrder: 1 };
  await this.commit();
  assert.equal(this.result, "committed");
});

Then("the session contains {string}", async function (this: StorageScenario, text: string) {
  const view = await this.view();
  assert.deepEqual(view.messages, [prompt(text)]);
  assert.deepEqual(view.metadata, { branch: "topic" });
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
  assert.deepEqual(await this.readCheckpoint(), { version: 1, checkpoint: this.batch.checkpoint });
});

When("the same request is revised to {int} input tokens and {int} output tokens", async function (
  this: StorageScenario, input: number, output: number,
) {
  this.batch = {
    ...this.batch, expectedVersion: 1, expectedOffset: 100, checkpoint: { offset: 200, parserState: "{}" },
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
  assert.deepEqual(await this.readCheckpoint(), { version: 0, checkpoint: null });
});

Given("two sources start with version zero for the same session", async function (this: StorageScenario) {
  const otherSource = { ...this.source, streamId: "second-log" };
  const first = await this.readCheckpoint();
  const second = await this.readCheckpoint(otherSource);
  assert.deepEqual(first, { version: 0, checkpoint: null });
  assert.deepEqual(second, first);
  this.batch.expectedVersion = first.version;
  this.batch.messages = [prompt("First source")];
  this.secondBatch = {
    ...this.batch, source: otherSource, expectedVersion: second.version,
    messages: [{ ...prompt("Second source"), id: "m2" }], usage: [observation(4, 2)],
    metadata: { branch: "other" }, hasGap: true,
  };
});

When("the first commits a message and the second submits its original batch", async function (this: StorageScenario) {
  assert(this.secondBatch);
  await this.commit();
  assert.equal(this.result, "committed");
  await this.commit(this.secondBatch);
});

Then("the second source has no checkpoint and sees session version {int}", async function (
  this: StorageScenario, version: number,
) {
  assert(this.secondBatch);
  assert.equal(this.result, "conflict");
  assert.deepEqual(await this.readCheckpoint(this.secondBatch.source), { version, checkpoint: null });
  assert.deepEqual(await this.readCheckpoint(), { version, checkpoint: this.batch.checkpoint });
  assert.deepEqual(await this.view(), {
    key: this.key, metadata: {}, messages: this.batch.messages, usage: [], coverage: "unknown", observedTotalTokens: null,
  });
});
