import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Given, Then, When } from "@cucumber/cucumber";
import { LoggingCommand } from "../../fixtures/logging-command.ts";

interface CloseScenario {
  args: string[];
  stderrMode?: "closed-pipe";
  stderr: string;
  report: Record<string, unknown>;
}

async function runCommand(scenario: CloseScenario) {
  const { stdout, stderr } = await LoggingCommand.run("fixtures/close-command", scenario.args, scenario.stderrMode);
  const report: unknown = JSON.parse(stdout);
  assert(report && typeof report === "object" && !Array.isArray(report), "Expected a close report");
  scenario.report = report as Record<string, unknown>;
  scenario.stderr = stderr;
}

Given("the selected log file path is an existing directory", function (this: CloseScenario) {
  this.args = ["directory", `${tmpdir()}/.`];
});

Given("the reader of the standard error pipe has closed", function (this: CloseScenario) {
  this.args = ["closed-pipe"];
  this.stderrMode = "closed-pipe";
});

When("the application reports a warning and waits for the logger to close", async function (this: CloseScenario) {
  await runCommand(this);
});

Then("close reports a file error with the selected path to the caller", function (this: CloseScenario) {
  const directory = resolve(tmpdir());
  assert.equal(this.stderr, "");
  assert.equal(this.report.filePath, directory);
  assert(typeof this.report.message === "string" && this.report.message.includes(directory));
  assert.match(String(this.report.causeCode), /^(EISDIR|EACCES|EPERM)$/);
});

Then("close reports a standard error write failure to the caller", function (this: CloseScenario) {
  assert.match(String(this.report.code ?? this.report.causeCode), /^(EPIPE|ECONNRESET)$/);
});

Given("a console logger has accepted {string}", function (this: CloseScenario, message: string) {
  this.args = ["healthy", message];
});

When("the command starts closing it twice and tries to log {string}", async function (this: CloseScenario, late: string) {
  this.args.push(late);
  await runCommand(this);
});

Then("the late call throws an error that says the logger is closed", function (this: CloseScenario) {
  assert.match(String(this.report.lateError), /closed/i);
});

Then("both close calls finish after {string} is written", function (this: CloseScenario, last: string) {
  assert.equal(this.report.sameClose, true);
  const [entry] = this.stderr.split("\n");
  assert.match(entry, / WARN /);
  assert(entry.endsWith(` ${last}`));
});

Then("the command can still write {string} to standard error", function (this: CloseScenario, message: string) {
  assert.deepEqual(this.stderr.split("\n").slice(1), [message, ""]);
});
