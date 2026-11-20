import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BeforeAll, Given, Then, When, setWorldConstructor } from "@cucumber/cucumber";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import type {
  Batch, CheckpointSnapshot, CollectorStorage, CommitResult, SessionKey, SessionView,
} from "../../../src/storage/collector-storage.ts";
import {
  claudeReport, codexMeasurement, codexParserState, codexSource, codexWindow, initialPlanningBatch, observation, prompt,
} from "../../fixtures/collector-storage-fixture.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";
import { inventoryLocation, inventoryScope, inventorySource, measuredSource, presence } from "../../fixtures/source-inventory-fixture.ts";

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
  store: CollectorStorage = new InMemoryCollectorStorage();
  batch = initialPlanningBatch();
  get source() { return this.batch.source; }
  get key(): SessionKey { return { harness: this.source.harness, sessionId: this.source.sessionId }; }
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
  const update = presence(1, "missing", 500);
  for (const fields of [{ presence: "unknown" }, { expectedVersion: -1 }, { observedEnd: 0.5 }, { location: { path: "file" } }]) {
    assert.equal(contract.validate("PresenceWrite.json", { ...update, ...fields }), false);
  }
});

BeforeAll(function () {
  const batch = initialPlanningBatch();
  checkWireValue("Batch", batch);
  const prefixDigest = "d".repeat(64);
  checkWireValue("Batch", {
    ...batch, resetFrom: batch.checkpoint, checkpoint: {
      ...batch.checkpoint, prefixDigest, replayThrough: { offset: batch.checkpoint.offset + 10, prefixDigest },
    },
    usageDiagnostics: [{ code: "ambiguous-transcript-replay", sourceOrder: 1 }],
  });
  checkWireValue("CheckpointSnapshot", { version: 1, checkpoint: { ...batch.checkpoint, prefixDigest } });
  for (const code of ["malformed-transcript-line", "unsupported-codex-usage", "codex-counter-reset", "unresolved-codex-fork", "unresolved-claude-fork"]) {
    const diagnostic = { code, sourceOrder: 3 };
    const byteRange = { startOffset: 50, endOffset: 60 };
    checkWireValue("UsageDiagnostic", { ...diagnostic, byteRange });
    checkWireValue("SourceUsageDiagnostic", { ...diagnostic, byteRange, streamId: batch.source.streamId });
    assert.equal(contract.validate("UsageDiagnostic.json", diagnostic), false);
    assert.equal(contract.validate("SourceUsageDiagnostic.json", { ...diagnostic, streamId: batch.source.streamId }), false);
  }
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
    [{ checkpoint: { ...batch.checkpoint, prefixDigest: "x".repeat(64) } }, "/checkpoint/prefixDigest"],
    [{ checkpoint: { ...batch.checkpoint, replayThrough: { offset: -1, prefixDigest } } }, "/checkpoint/replayThrough/offset"],
    [{ resetFrom: { ...batch.checkpoint, prefixDigest: "abc" } }, "/resetFrom/prefixDigest"],
    [{ usageDiagnostics: [{ code: "malformed-transcript-line", sourceOrder: 3, byteRange: { startOffset: -1, endOffset: 5 } }] },
      "/usageDiagnostics/0/byteRange/startOffset"],
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

BeforeAll(function () {
  const batch = initialPlanningBatch();
  const origin = { kind: "copy", parentSessionId: "parent", parentMessageUuid: "source-row", transcriptUuid: "copy-row",
    sourceOrder: 1, byteRange: { startOffset: 0, endOffset: 60 } } as const;
  const saved = { ...batch.checkpoint, prefixDigest: "c".repeat(64) };
  const checkpoint = { ...saved, claudeCallOrigins: true };
  checkWireValue("ClaudeUsageReport", claudeReport({ origin }));
  checkWireValue("Batch", { ...batch, expectedOffset: saved.offset, checkpoint,
    backfillClaudeOriginsFrom: saved, claudeUsageReports: [claudeReport({ origin })] });
  assert.equal(contract.validate("Batch.json", { ...batch, checkpoint, claudeUsageReports: [claudeReport()] }), false);
  for (const fields of [{ kind: "unknown" }, { sourceOrder: 0 }, { byteRange: undefined }, { parentMessageUuid: "" },
    { parentSessionId: undefined }, { kind: "own" }, { kind: "subagent", parentSessionId: undefined, parentMessageUuid: undefined }]) {
    assert.equal(contract.validate("ClaudeCallOrigin.json", { ...origin, ...fields }), false);
  }
  for (const fields of [{ claudeCallOrigins: false }, { codexFork: { parentSessionId: "parent" } }, { prefixDigest: undefined }]) {
    assert.equal(contract.validate("Checkpoint.json", { ...checkpoint, ...fields }), false);
  }
});

BeforeAll(function () {
  const call = { ...codexMeasurement("call", "call", 30), model: "model", turnId: "turn", requestId: "request" };
  const interval = codexMeasurement("interval", "interval", 20);
  const window = codexWindow(0, 50, call, interval);
  const anchor = { usageId: call.id, historyId: window.historyId, after: window.start };
  const batch: Batch = {
    source: codexSource, expectedVersion: 1, expectedOffset: 100, checkpoint: { offset: 100, parserState: codexParserState(2) },
    messages: [], usage: [call], usageAnchors: [anchor], usageWindows: [window],
    upgradeFromParserState: "{}",
  };
  checkWireValue("TokenCounts", window.end);
  checkWireValue("UsageKind", call.kind);
  checkWireValue("UsageWindow", window);
  const boundaries = { start: "a".repeat(64), end: "b".repeat(64) };
  checkWireValue("UsageWindow", { ...window, boundaryObservations: boundaries });
  for (const invalid of [null, { end: boundaries.end }, { ...boundaries, start: "invalid" }]) {
    assert.equal(contract.validate("UsageWindow.json", { ...window, boundaryObservations: invalid }), false);
  }
  checkWireValue("UsageAnchor", anchor);
  const copied = { offset: 80, lineNumber: 3, prefixDigest: boundaries.end };
  const fork = { parentSessionId: "parent", inheritedThrough: copied, baseline: window.end };
  const claim = { providerId: boundaries.start, usageId: call.id, ownerSessionId: codexSource.sessionId };
  checkWireValue("Batch", { ...batch, checkpoint: { ...batch.checkpoint, prefixDigest: boundaries.start, codexFork: fork },
    codexCallClaims: [claim], reconcileCodexForkFrom: batch.checkpoint, upgradeFromParserState: undefined });
  for (const invalid of [{ ...fork, inheritedThrough: { ...copied, lineNumber: 0 } }, { ...fork, inheritedThrough: undefined },
    { ...fork, firstUncertain: { offset: 0, lineNumber: 1 } }]) {
    assert.equal(contract.validate("CodexForkCheckpoint.json", invalid), false);
  }
  assert.equal(contract.validate("CodexCallClaim.json", { ...claim, providerId: "invalid" }), false);
  checkWireValue("Batch", batch);
  checkWireValue("SessionView", {
    key: { harness: codexSource.harness, sessionId: codexSource.sessionId }, metadata: {}, messages: [],
    usage: [call, interval, observation(10, 2)], coverage: "reported", observedTotalTokens: 62,
  });
  const malformed: [object, string][] = [
    [{ usage: [{ ...call, kind: "other" }] }, "/usage/0/kind"],
    [{ usage: [{ ...call, turnId: "" }] }, "/usage/0/turnId"],
    [{ usage: [{ ...call, requestId: "" }] }, "/usage/0/requestId"],
    [{ usageAnchors: [{ ...anchor, usageId: "" }] }, "/usageAnchors/0/usageId"],
    [{ usageAnchors: [{ ...anchor, historyId: "" }] }, "/usageAnchors/0/historyId"],
    [{ usageAnchors: [{ ...anchor, after: { ...window.start, inputTokens: -1 } }] }, "/usageAnchors/0/after/inputTokens"],
    [{ usageWindows: [{ ...window, historyId: "" }] }, "/usageWindows/0/historyId"],
    [{ usageWindows: [{ ...window, start: { inputTokens: 0 } }] }, "/usageWindows/0/start"],
    [{ usageWindows: [{ ...window, end: { ...window.end, outputTokens: -1 } }] }, "/usageWindows/0/end/outputTokens"],
    [{ usageWindows: [{ ...window, parts: null }] }, "/usageWindows/0/parts"],
    [{ usageWindows: [{ ...window, parts: [{ ...interval, revision: 0 }] }] }, "/usageWindows/0/parts/0/revision"],
    [{ upgradeFromParserState: null }, "/upgradeFromParserState"],
  ];
  for (const [fields, path] of malformed) {
    assert.equal(contract.validate("Batch.json", { ...batch, ...fields }), false, path);
    assert(contract.errors?.some(error => error.instancePath === path), contract.errorsText());
  }
});

const finalReport = claudeReport({ status: "final", outputTokens: 91, cacheWrite5mTokens: 2, cacheWrite1hTokens: 3 });
const unsupportedIteration = { code: "unsupported-claude-iteration", sourceOrder: 4 } as const;

BeforeAll(function () {
  const batch = initialPlanningBatch();
  const report = finalReport;
  const diagnostic = unsupportedIteration;
  checkWireValue("ClaudeUsageReport", report);
  checkWireValue("UsageStatus", report.status);
  checkWireValue("UsageDiagnostic", diagnostic);
  for (const [fields, path] of [
    [{ claudeUsageReports: [{ ...report, status: "unknown" }] }, "/claudeUsageReports/0/status"],
    [{ claudeUsageReports: [{ ...report, messageId: undefined, requestId: undefined }] }, "/claudeUsageReports/0"],
    [{ claudeUsageReports: [{ ...report, messageId: "" }] }, "/claudeUsageReports/0/messageId"],
    [{ claudeUsageReports: [{ ...report, iterationId: "" }] }, "/claudeUsageReports/0/iterationId"],
    [{ claudeUsageReports: [{ ...report, cacheWrite5mTokens: -1 }] }, "/claudeUsageReports/0/cacheWrite5mTokens"],
    [{ usageDiagnostics: [{ ...diagnostic, code: "wrong" }] }, "/usageDiagnostics/0/code"],
    [{ usageDiagnostics: [{ ...diagnostic, sourceOrder: 0 }] }, "/usageDiagnostics/0/sourceOrder"],
  ] as const) {
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

Given("a source has reported 70 tokens at byte 420 of 500", async function (this: StorageScenario) {
  this.batch = measuredSource(500);
  await this.commit();
  assert.equal(this.result, "committed");
  assert.equal((await this.view()).observedTotalTokens, 70);
  checkWireValue("SourceScope", inventoryScope);
  const sources = await this.store.listSources(inventoryScope);
  assert.deepEqual(sources, [{ source: inventorySource, location: inventoryLocation, version: 1,
    acceptedOffset: 420, observedEnd: 500, presence: "present" }]);
  checkWireValue("AcknowledgedSource", sources[0]);
});

When("the collector reports that source missing", async function (this: StorageScenario) {
  const update = presence(1, "missing", 500);
  checkWireValue("PresenceWrite", update);
  assert.equal(await this.store.recordPresence(update), "committed");
});

Then("the source list and the session report it missing at byte {int}", async function (this: StorageScenario, offset: number) {
  const sources = await this.store.listSources(inventoryScope);
  assert.deepEqual(sources, [{ source: inventorySource, location: inventoryLocation, version: 2,
    acceptedOffset: offset, observedEnd: 500, presence: "missing", unrecovered: { offset: 500 } }]);
  checkWireValue("AcknowledgedSource", sources[0]);
  assert.deepEqual(await this.readCheckpoint(), { version: 2, checkpoint: this.batch.checkpoint, observedThrough: { offset: 500 } });
  const view = await this.view();
  assert.deepEqual(view.missingSources, [{ source: inventorySource, acceptedOffset: offset, observedEnd: 500, status: "missing" }]);
  checkWireValue("MissingSource", view.missingSources[0]);
  assert.equal(view.observedTotalTokens, 70);
  assert.equal(view.coverage, "partial");
});

When("a final Claude report includes 131 tokens and an unsupported iteration", async function (this: StorageScenario) {
  this.batch = { ...this.batch, source: { ...this.source, installationId: "desktop" },
    claudeUsageReports: [finalReport], usageDiagnostics: [unsupportedIteration], hasGap: true };
  await this.commit();
  assert.equal(this.result, "committed");
});

Then("the session reports {int} tokens with partial coverage and the diagnostic for that source", async function (
  this: StorageScenario, total: number,
) {
  assert.deepEqual(await this.readCheckpoint(), { version: 1, checkpoint: this.batch.checkpoint });
  const view = await this.view();
  assert.equal(view.observedTotalTokens, total);
  assert.equal(view.coverage, "partial");
  assert.equal(view.usage.length, 1);
  assert.deepEqual(view.usage[0], { ...finalReport, id: view.usage[0].id, kind: "call", revision: 1 });
  assert.deepEqual(view.usageDiagnostics, [{ ...unsupportedIteration, streamId: this.source.streamId, installationId: "desktop" }]);
  checkWireValue("SourceUsageDiagnostic", view.usageDiagnostics[0]);
});
