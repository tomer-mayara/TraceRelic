import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { CallerProbe } from "../../fixtures/caller-probe.ts";
import { LoggingCommand } from "../../fixtures/logging-command.ts";

interface CaptureScenario {
  firstMessage: string;
  stackLimit: number;
  failure: string;
  entries: unknown[];
}

Given("the file logger has accepted {string}", function (this: CaptureScenario, message: string) {
  this.firstMessage = message;
});

Given("the next call has an empty stack", function (this: CaptureScenario) {
  this.stackLimit = 0;
});

Given("the next call has only the logger's own frames", function (this: CaptureScenario) {
  this.stackLimit = 1;
});

When("the application reports {string} and closes the logger", async function (this: CaptureScenario, message: string) {
  const probe = await CallerProbe.create();
  try {
    const result = await LoggingCommand.run("fixtures/missing-caller", [
      probe.filePath, this.firstMessage, message, String(this.stackLimit),
    ]);
    assert.equal(result.stderr, "");
    this.failure = result.stdout;
    this.entries = await probe.entries();
  } finally {
    await probe.close();
  }
});

Then("close reports that the calling file and line are unavailable", function (this: CaptureScenario) {
  assert.equal(this.failure, "The calling file and line are unavailable");
});

Then("the file contains exactly one entry with the message {string}", function (this: CaptureScenario, message: string) {
  assert.equal(this.entries.length, 1);
  assert.partialDeepStrictEqual(this.entries[0], { level: "warn", message });
});
