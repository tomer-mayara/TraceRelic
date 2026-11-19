import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { After, BeforeAll, Given, Then, When, type DataTable, setWorldConstructor } from "@cucumber/cucumber";
import { Ajv2020, type AnySchemaObject } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { GlobalConfig, globalConfigFileSchema } from "@tracerelic/collector/config";
import { LocalLLMHistoryClaude, LocalLLMHistoryCodex, type LocalHistoryEntry, type LocalLLMHistory } from "@tracerelic/collector/history";
import { ClaudeProjectFixture } from "../../fixtures/claude-project-fixture.ts";
import { CodexRolloutFixture as Rollout } from "../../fixtures/codex-rollout-fixture.ts";

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
  fixture!: Rollout | ClaudeProjectFixture;
  reader!: LocalLLMHistory;
  entries!: readonly LocalHistoryEntry[];
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
  this.reader = new LocalLLMHistoryCodex(config);
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
  this.reader = new LocalLLMHistoryClaude(config);
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
