import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { After, BeforeAll, Given, Then, When, type DataTable, setWorldConstructor } from "@cucumber/cucumber";
import { Ajv2020, type AnySchemaObject } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { GlobalConfig, globalConfigFileSchema } from "@tracerelic/collector/config";
import { LocalLLMHistoryCodex, type LocalHistoryEntry, type LocalLLMHistory } from "@tracerelic/collector/history";
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
  fixture!: Rollout;
  reader!: LocalLLMHistory;
  entries!: readonly LocalHistoryEntry[];
  messages!: ReturnType<typeof Rollout.message>[];
}
setWorldConstructor(HistoryScenario);

Given("the Codex rollout for {string} starts on January 31 and contains these messages", async function (
  this: HistoryScenario, id: string, table: DataTable,
) {
  this.fixture = await Rollout.create();
  const config = new GlobalConfig(this.fixture.home);
  assert(contract.validate("GlobalConfig.json", config), contract.errorsText());
  this.reader = new LocalLLMHistoryCodex(config);
  this.messages = table.hashes().map(row => Rollout.message(row["recorded at"], row.text));
  await this.fixture.write([Rollout.header(id), ...this.messages]);
});

After(async function (this: HistoryScenario) { await this.fixture?.close(); });

When("I read history from {string} to {string}", async function (this: HistoryScenario, start: string, end: string) {
  this.entries = await this.reader.readLocalHistory(new Date(start), new Date(end));
});

Then("I get only {string} and {string} in that order for {string}", function (
  this: HistoryScenario, first: string, second: string, session: string,
) {
  const expected = [first, second].map(text => {
    const record = this.messages.find(row => row.payload.content[0].text === text);
    assert(record);
    return { session, record };
  });
  assert.deepEqual(this.entries.map(entry => ({ session: entry.harness + "/" + entry.sessionId, record: entry.record })), expected);
  for (const entry of this.entries) assert(contract.validate("LocalHistoryEntry.json", entry), contract.errorsText());
});
