import assert from "node:assert/strict";
import { After, Before, Given, Then, When, setWorldConstructor } from "@cucumber/cucumber";
import { collectorLogMessage } from "../../fixtures/collector-log-message.ts";
import { LocalCollectorCliFixture } from "../../fixtures/local-collector-cli-fixture.ts";

class ConfigScenario {
  fixture!: LocalCollectorCliFixture;
  path!: string;
  result!: ReturnType<LocalCollectorCliFixture["history"]>;
}
setWorldConstructor(ConfigScenario);

Before(async function (this: ConfigScenario) { this.fixture = await LocalCollectorCliFixture.create(); });
After(async function (this: ConfigScenario) { await this.fixture?.close(); });

Given("a configuration with a relative Codex path containing the chat {string}", async function (this: ConfigScenario, id: string) {
  this.path = await this.fixture.writeConfig("..");
  await this.fixture.writeChat(this.fixture.configured, id);
});

Given("the shell points Codex at a different directory containing the chat {string}", async function (this: ConfigScenario, id: string) {
  await this.fixture.writeChat(this.fixture.elsewhere, id);
});

Given("a configuration with an empty Codex path", async function (this: ConfigScenario) {
  this.path = await this.fixture.writeConfig("");
});

Given("a configuration with a Codex chat {string} and a Claude chat {string} in separate directories", async function (
  this: ConfigScenario, codexId: string, claudeId: string,
) {
  this.path = await this.fixture.writeConfig("..", "../claude");
  await this.fixture.writeChat(this.fixture.configured, codexId);
  await this.fixture.writeClaudeChat(claudeId);
});

When("I read February 1 history with that configuration", function (this: ConfigScenario) {
  this.result = this.fixture.history(this.path);
});

Given("both configured providers recorded a chat at {string}", async function (this: ConfigScenario, at: string) {
  this.path = await this.fixture.writeConfig("..", "../claude");
  await this.fixture.writeChat(this.fixture.configured, "c1", at);
  await this.fixture.writeClaudeChat("h1", at);
});

When("I read the configured history from {string} to {string}", function (this: ConfigScenario, from: string, to: string) {
  this.result = this.fixture.run(["history", "--config", this.path, "--from", from, "--to", to]);
});

Then("the collector returns only the chat {string}", function (this: ConfigScenario, id: string) {
  assert.equal(this.result.status, 0, this.result.stderr);
  const history: unknown = JSON.parse(this.result.stdout);
  assert(Array.isArray(history));
  assert.deepEqual(history.map(entry => entry.sessionId), [id]);
});

Then("the collector writes no diagnostics to standard error", function (this: ConfigScenario) {
  assert.equal(this.result.stderr, "");
});

Then("the collector writes one ERROR log for {string} to standard error", function (this: ConfigScenario, field: string) {
  assert.equal(this.result.status, 1);
  const message = collectorLogMessage(this.result.stderr, "ERROR");
  assert(message.includes(field), message);
  assert(message.includes("local.json"), message);
});

Then("standard output is empty", function (this: ConfigScenario) {
  assert.equal(this.result.stdout, "");
});

Then("the collector returns the chats {string} and {string}", function (this: ConfigScenario, one: string, two: string) {
  assert.equal(this.result.status, 0, this.result.stderr);
  const history: unknown = JSON.parse(this.result.stdout);
  assert(Array.isArray(history));
  assert.deepEqual(history.map(entry => entry.harness + "/" + entry.sessionId).sort(), [one, two].sort());
});
