import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { After, Before, Given, Then, When, setWorldConstructor } from "@cucumber/cucumber";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { GlobalConfigLoader } from "@tracerelic/collector/config";
import { LocalLLMHistoryClaude, LocalLLMHistoryCodex, type ScanSelection } from "@tracerelic/collector/history";
import type { SessionKey, SessionView } from "../../../src/storage/collector-storage.ts";
import { ScanCommandFixture } from "../../fixtures/scan-command-fixture.ts";

const schemaFile = new URL(
  "../../dist/collector-scan/scan.schema.json", import.meta.resolve("@tracerelic/collector/package.json"),
);
const schema: unknown = JSON.parse(readFileSync(schemaFile, "utf8"));
assert(schema && typeof schema === "object" && "$schema" in schema && typeof schema.$schema === "string");
const contract = new Ajv2020({ formats: fullFormats }).addSchema({ ...schema, $schema: schema.$schema });

class ScanScenario {
  fixture!: ScanCommandFixture;
  growing!: Awaited<ReturnType<ScanCommandFixture["writeGrowingClaudeFile"]>>;
  first!: Awaited<ReturnType<ScanScenario["scanGrowingFile"]>>;
  second!: Awaited<ReturnType<ScanScenario["scanGrowingFile"]>>;

  async scanGrowingFile() {
    const views = await this.fixture.scan("--session", this.fixture.claudeKey.sessionId);
    assert.equal(views.length, 1);
    const [view] = views;
    assert("messages" in view);
    const progress = await this.fixture.storage.readCheckpoint(this.growing.source);
    return { texts: view.messages.map(message => message.text), progress };
  }

  async checkSourceAndBatches(
    reader: LocalLLMHistoryCodex | LocalLLMHistoryClaude, selection: ScanSelection,
    batchSchema: "CodexRecordBatch.json" | "ClaudeRecordBatch.json",
  ): Promise<void> {
    let sourceCount = 0;
    for await (const source of reader.discoverSources(selection)) {
      sourceCount++;
      assert(contract.validate("TranscriptSourceInfo.json", source), contract.errorsText());
      let batchCount = 0;
      for await (const batch of source.readBatches({ offset: 0, lineNumber: 0 })) {
        batchCount++;
        assert(contract.validate(batchSchema, batch), contract.errorsText());
      }
      assert(batchCount > 0);
    }
    assert.equal(sourceCount, 1);
  }

  async session(key: SessionKey): Promise<SessionView> {
    const session = await this.fixture.storage.readSession(key);
    assert(session, `${key.harness}/${key.sessionId} is absent after the scan`);
    assert(contract.validate("SessionView.json", session), contract.errorsText());
    assert.deepEqual(session.key, key);
    return session;
  }
}

setWorldConstructor(ScanScenario);
Before(async function (this: ScanScenario) {
  this.fixture = await ScanCommandFixture.create();
  await this.fixture.configure();
});
After(async function (this: ScanScenario) { await this.fixture?.close(); });

Given("a selected Codex session contains the prompt {string} and the reply {string}", async function (
  this: ScanScenario, prompt: string, reply: string,
) {
  await this.fixture.writePlanningChat(prompt, reply);
  const selection = { sessionIds: [this.fixture.codexKey.sessionId] };
  assert(contract.validate("ScanSelection.json", selection), contract.errorsText());
  const reader = new LocalLLMHistoryCodex(await GlobalConfigLoader.load(this.fixture.configFile));
  await this.checkSourceAndBatches(reader, selection, "CodexRecordBatch.json");
  const rollouts = await Array.fromAsync(reader.readRollouts(selection));
  assert.equal(rollouts.length, 1);
  assert(contract.validate("CodexRollout.json", rollouts[0]), contract.errorsText());
});

When("I scan its root once", async function (this: ScanScenario) {
  await this.fixture.scan("--session", this.fixture.codexKey.sessionId);
});

Then("its session contains both messages in source order with their roles and recorded times", async function (this: ScanScenario) {
  const session = await this.session(this.fixture.codexKey);
  assert.deepEqual(session.messages.map(({ at, role, text }) => ({ at, role, text })), this.fixture.codexMessages);
});

Then("its token total is null with unknown coverage", async function (this: ScanScenario) {
  const session = await this.session(this.fixture.codexKey);
  assert.equal(session.observedTotalTokens, null);
  assert.equal(session.coverage, "unknown");
  assert.deepEqual(session.usage, []);
});

Given("a Claude session contains {string} twice and one assistant response has two text blocks", async function (
  this: ScanScenario, prompt: string,
) {
  await this.fixture.writeRepeatedClaudePrompt(prompt);
  const selection = { projectPaths: [this.fixture.projectPath] };
  assert(contract.validate("ScanSelection.json", selection), contract.errorsText());
  const reader = new LocalLLMHistoryClaude(await GlobalConfigLoader.load(this.fixture.configFile));
  await this.checkSourceAndBatches(reader, selection, "ClaudeRecordBatch.json");
  const transcripts = await Array.fromAsync(reader.readTranscripts(selection));
  assert.equal(transcripts.length, 1);
  assert.equal(transcripts[0].sessionId, this.fixture.claudeKey.sessionId);
  assert(contract.validate("ClaudeTranscript.json", transcripts[0]), contract.errorsText());
});

When("I scan its project twice", async function (this: ScanScenario) {
  await this.fixture.scan("--project", this.fixture.projectPath);
  await this.fixture.scan("--project", this.fixture.projectPath);
});

Then("both prompts appear and both answer blocks appear once in their original order", async function (this: ScanScenario) {
  const session = await this.session(this.fixture.claudeKey);
  assert.deepEqual(session.messages.map(({ at, role, text }) => ({ at, role, text })), this.fixture.claudeMessages);
  const promptIds = session.messages.filter(message => message.role === "user").map(message => message.id);
  assert.equal(new Set(promptIds).size, 2);
  assert.equal(session.observedTotalTokens, null);
  assert.equal(session.coverage, "unknown");
  assert.deepEqual(session.usage, []);
});

Given("a Codex planning chat has cumulative totals of {int}, {int} and {int}", async function (
  this: ScanScenario, first: number, repeated: number, last: number,
) {
  await this.fixture.writeCumulativeReports(first, repeated, last);
});

Given("one Claude request has {int} input tokens and reports {int} then {int} output tokens", async function (
  this: ScanScenario, input: number, provisional: number, final: number,
) {
  await this.fixture.writeClaudeRequest(input, provisional, final);
});

When("I scan twice and restart the collector against the same storage", async function (this: ScanScenario) {
  await this.fixture.scan();
  await this.fixture.scan();
  this.fixture.restart();
  await this.fixture.scan();
});

Then("the totals are {int} for Codex and {int} for Claude", async function (
  this: ScanScenario, codex: number, claude: number,
) {
  assert.equal((await this.session(this.fixture.codexKey)).observedTotalTokens, codex);
  assert.equal((await this.session(this.fixture.claudeKey)).observedTotalTokens, claude);
});

When("I append a {int}-token Codex call and scan again", async function (this: ScanScenario, tokens: number) {
  await this.fixture.appendCodexCall(tokens);
  await this.fixture.scan();
});

Then("each original text block appears once in its chat", async function (this: ScanScenario) {
  const codex = await this.session(this.fixture.codexKey);
  const claude = await this.session(this.fixture.claudeKey);
  assert.deepEqual(codex.messages.map(message => message.text), this.fixture.codexMessages.map(message => message.text));
  assert.deepEqual(claude.messages.map(message => message.text), this.fixture.claudeTexts);
});

Given("one line is complete and the next ends between the two bytes of {string} in {string}", async function (
  this: ScanScenario, character: string, secondText: string,
) {
  this.growing = await this.fixture.writeGrowingClaudeFile(character, secondText);
});

When("I scan once, finish the second line and scan with a fresh collector", async function (this: ScanScenario) {
  this.first = await this.scanGrowingFile();
  await this.growing.finish();
  this.fixture.restart();
  this.second = await this.scanGrowingFile();
});

Then("the first scan stores only the first message", function (this: ScanScenario) {
  assert.deepEqual(this.first.texts, [this.growing.firstText]);
});

Then("the second scan stores {string} once and acknowledges its ending newline", async function (
  this: ScanScenario, secondText: string,
) {
  assert.deepEqual(this.second.texts, [this.growing.firstText, secondText]);
  assert.deepEqual(await this.scanGrowingFile(), this.second);
  assert.equal(this.second.progress.checkpoint?.offset, this.growing.secondOffset);
});

Then("both checkpoints record the accepted line and session version", function (this: ScanScenario) {
  for (const [scan, lineNumber, offset] of [
    [this.first, 1, this.growing.firstOffset], [this.second, 2, this.growing.secondOffset],
  ] as const) {
    assert(contract.validate("CheckpointSnapshot.json", scan.progress), contract.errorsText());
    assert.equal(scan.progress.version, lineNumber);
    assert(scan.progress.checkpoint);
    assert.equal(scan.progress.checkpoint.offset, offset);
    const state: unknown = JSON.parse(scan.progress.checkpoint.parserState);
    assert(contract.validate("ParserCheckpointState.json", state), contract.errorsText());
    assert.partialDeepStrictEqual(state, { version: 1, lineNumber });
  }
});
