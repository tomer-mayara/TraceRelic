import assert from "node:assert/strict";
import { After, Before, Given, Then, When, setWorldConstructor } from "@cucumber/cucumber";
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

When("I read February 1 history with that configuration", function (this: ConfigScenario) {
  this.result = this.fixture.history(this.path);
});

Then("the collector returns only the chat {string}", function (this: ConfigScenario, id: string) {
  assert.equal(this.result.status, 0, this.result.stderr);
  const history: unknown = JSON.parse(this.result.stdout);
  assert(Array.isArray(history));
  assert.deepEqual(history.map(entry => entry.sessionId), [id]);
});

Then("the collector reports a configuration error for {string}", function (this: ConfigScenario, field: string) {
  assert.equal(this.result.status, 1);
  assert.equal(this.result.stdout, "");
  assert(this.result.stderr.includes(field), this.result.stderr);
  assert(this.result.stderr.includes("local.json"), this.result.stderr);
});
