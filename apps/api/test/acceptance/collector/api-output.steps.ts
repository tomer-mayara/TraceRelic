import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { CollectorApiProcess } from "../../fixtures/collector-api-process.ts";

interface ApiOutputScenario {
  port: string;
  result: ReturnType<typeof CollectorApiProcess.runToExit>;
}

Given("the API port is set to {string}", function (this: ApiOutputScenario, port: string) {
  this.port = port;
});

When("the operator starts the API", function (this: ApiOutputScenario) {
  this.result = CollectorApiProcess.runToExit(undefined, this.port);
});

Then("stderr contains one ERROR log that explains the valid port range", function (this: ApiOutputScenario) {
  const diagnostic = /^(\S+) ERROR (?:[^\r\n]*[/\\])?main\.(?:ts|js):[1-9]\d* PORT must be an integer from 0 through 65535\n$/;
  const fields = diagnostic.exec(this.result.stderr);
  assert(fields, `Unexpected API diagnostic: ${JSON.stringify(this.result.stderr)}`);
  assert.equal(fields[1], new Date(fields[1]).toISOString());
});

Then("the API exits with status {int} and leaves stdout empty", function (this: ApiOutputScenario, status: number) {
  assert.equal(this.result.status, status);
  assert.equal(this.result.stdout, "");
});
