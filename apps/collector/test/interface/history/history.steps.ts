import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { After, BeforeAll, Given, Then, When, type DataTable, setWorldConstructor } from "@cucumber/cucumber";
import { Ajv2020, type AnySchemaObject } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { GlobalConfig, globalConfigFileSchema } from "@tracerelic/collector/config";
import { LocalLLMHistory, type LocalHistoryEntry } from "@tracerelic/collector/history";
import { ClaudeHistory, CodexHistory, LocalProviders } from "@tracerelic/collector/providers";
import { ClaudeProjectFixture } from "../../fixtures/claude-project-fixture.ts";
import { CodexRolloutFixture as Rollout } from "../../fixtures/codex-rollout-fixture.ts";
import { HistoryWindowFixture } from "../../fixtures/history-window-fixture.ts";
import { ProviderHistoryFixture } from "../../fixtures/provider-history-fixture.ts";

const schemaFile = new URL(
  "../../dist/collector-history/history.schema.json", import.meta.resolve("@tracerelic/collector/package.json"),
);
const schema: unknown = JSON.parse(readFileSync(schemaFile, "utf8"));
assert(schema && typeof schema === "object" && "$schema" in schema && typeof schema.$schema === "string");
const contract = new Ajv2020({ formats: fullFormats }).addSchema({ ...schema, $schema: schema.$schema });

function configValidationRules({ $id: _id, $schema: _dialect, properties, ...rules }: AnySchemaObject) {
  const fields = Object.entries(properties).map(([name, field]) => {
    assert(field && typeof field === "object");
    const keywords = Object.entries(field).filter(([key]) => key !== "description");
    return [name, Object.fromEntries(keywords)];
  });
  return { additionalProperties: true, ...rules, properties: Object.fromEntries(fields) };
}

BeforeAll(function () {
  const published = contract.getSchema("GlobalConfig.json")?.schema;
  assert(published && typeof published === "object");
  assert.deepEqual(configValidationRules(published), configValidationRules(globalConfigFileSchema));
});

class HistoryScenario {
  fixture!: Rollout | ClaudeProjectFixture | HistoryWindowFixture | ProviderHistoryFixture;
  reader!: LocalLLMHistory;
  entries!: readonly LocalHistoryEntry[];
  firstDay!: readonly LocalHistoryEntry[];
  messages = new Map<string, object>();

  expectMessages(sessions: Record<string, string[]>): void {
    assert.equal(this.entries.length, Object.values(sessions).flat().length);
    for (const [session, texts] of Object.entries(sessions)) {
      const records = this.entries.filter(entry => entry.harness + "/" + entry.sessionId === session);
      assert.deepEqual(records.map(entry => entry.record), texts.map(text => this.messages.get(text)));
    }
    for (const entry of this.entries) assert(contract.validate("LocalHistoryEntry.json", entry), contract.errorsText());
  }
}
setWorldConstructor(HistoryScenario);

Given("the Codex rollout for {string} starts on January 31 and contains these messages", async function (
  this: HistoryScenario, id: string, table: DataTable,
) {
  this.fixture = await Rollout.create();
  const config = new GlobalConfig(this.fixture.home);
  assert(contract.validate("GlobalConfig.json", config), contract.errorsText());
  this.reader = new LocalLLMHistory([new CodexHistory(config.codexPath)]);
  const records = table.hashes().map(row => {
    const record = Rollout.message(row["recorded at"], row.text);
    this.messages.set(row.text, record);
    return record;
  });
  await this.fixture.write([Rollout.header(id), ...records]);
});

Given("Claude Code project transcripts contain these records on February 1, 2026 UTC", async function (
  this: HistoryScenario, table: DataTable,
) {
  this.fixture = await ClaudeProjectFixture.create();
  const config = new GlobalConfig(join(this.fixture.home, "codex"), this.fixture.home);
  assert(contract.validate("GlobalConfig.json", config), contract.errorsText());
  assert(config.claudePath);
  this.reader = new LocalLLMHistory([new ClaudeHistory(config.claudePath)]);
  const projects = new Map<string, object[]>();
  for (const { session, time, role, text } of table.hashes()) {
    const timestamp = "2026-02-01T" + time + "Z";
    assert(role === "user" || role === "assistant");
    const record = ClaudeProjectFixture[role](session, timestamp, text);
    this.messages.set(text, record);
    const records = projects.get(session) ?? [];
    records.push(record);
    projects.set(session, records);
  }
  for (const [session, records] of projects) await this.fixture.write("project-" + session, session, records);
});

After(async function (this: HistoryScenario) { await this.fixture?.close(); });

When("I read history from {string} to {string}", async function (this: HistoryScenario, start: string, end: string) {
  this.entries = await this.reader.readLocalHistory(new Date(start), new Date(end));
});

Then("I get only {string} and {string} in that order for {string}", function (
  this: HistoryScenario, first: string, second: string, session: string,
) {
  this.expectMessages({ [session]: [first, second] });
});

Then("I get only {string} for {string} and {string} for {string}", function (
  this: HistoryScenario, first: string, firstSession: string, second: string, secondSession: string,
) {
  this.expectMessages({ [firstSession]: [first], [secondSession]: [second] });
});

Given("a {} transcript records {string} at {string}", async function (
  this: HistoryScenario, provider: string, text: string, timestamp: string,
) {
  assert(provider === "Codex" || provider === "Claude Code");
  this.fixture = await HistoryWindowFixture.create(provider);
  this.reader = this.fixture.reader();
  const record = this.fixture.message(timestamp, text);
  this.messages.set(text, record);
  await this.fixture.write([record]);
});

const february1 = new Date("2026-02-01T00:00:00Z");
const february2 = new Date("2026-02-02T00:00:00Z");
const february3 = new Date("2026-02-03T00:00:00Z");

When("I read February 1 UTC and February 2 UTC as separate one-day windows", async function (this: HistoryScenario) {
  this.firstDay = await this.reader.readLocalHistory(february1, february2);
  this.entries = await this.reader.readLocalHistory(february2, february3);
});

Then("only the February 2 result contains {string}", function (this: HistoryScenario, text: string) {
  assert.deepEqual(this.firstDay, []);
  assert.deepEqual(this.entries.map(entry => entry.record), [this.messages.get(text)]);
});

Then("reading the two days together returns that record once", async function (this: HistoryScenario) {
  assert.deepEqual(await this.reader.readLocalHistory(february1, february3), this.entries);
});

Given("Codex chat {string} records {string} and Claude Code chat {string} records {string} on February 1", async function (
  this: HistoryScenario, codexChat: string, codexText: string, claudeChat: string, claudeText: string,
) {
  const fixture = await ProviderHistoryFixture.create();
  this.fixture = fixture;
  // The Claude Code record is earlier. Thus only the sequence of the providers puts Codex first.
  const codexRecord = Rollout.message("2026-02-01T09:00:00Z", codexText);
  const claudeRecord = ClaudeProjectFixture.assistant(claudeChat, "2026-02-01T08:00:00Z", claudeText);
  this.messages.set(codexText, codexRecord);
  this.messages.set(claudeText, claudeRecord);
  await fixture.codex.write([Rollout.header(codexChat), codexRecord]);
  await fixture.claude.write("-work", claudeChat, [claudeRecord]);
});

When("I read February 1 UTC with one reader for both providers", async function (this: HistoryScenario) {
  assert(this.fixture instanceof ProviderHistoryFixture);
  const config = this.fixture.config();
  assert(contract.validate("GlobalConfig.json", config), contract.errorsText());
  this.reader = new LocalLLMHistory(LocalProviders.fromConfig(config));
  this.entries = await this.reader.readLocalHistory(february1, february2);
});

When("I read February 1 UTC with a reader for Codex alone", async function (this: HistoryScenario) {
  assert(this.fixture instanceof ProviderHistoryFixture);
  this.reader = new LocalLLMHistory([new CodexHistory(this.fixture.codex.home)]);
  this.entries = await this.reader.readLocalHistory(february1, february2);
});

Then("I get {string} for {string} and then {string} for {string}", function (
  this: HistoryScenario, first: string, firstSession: string, second: string, secondSession: string,
) {
  this.expectMessages({ [firstSession]: [first], [secondSession]: [second] });
  assert.deepEqual(this.entries.map(entry => entry.harness + "/" + entry.sessionId), [firstSession, secondSession]);
});

Then("I get only {string} for {string}", function (this: HistoryScenario, text: string, session: string) {
  this.expectMessages({ [session]: [text] });
});
