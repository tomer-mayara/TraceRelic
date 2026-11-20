import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { After, Before, Given, Then, When, setWorldConstructor } from "@cucumber/cucumber";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { GlobalConfigLoader } from "@tracerelic/collector/config";
import { LocalLLMHistoryCodex } from "@tracerelic/collector/history";
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
