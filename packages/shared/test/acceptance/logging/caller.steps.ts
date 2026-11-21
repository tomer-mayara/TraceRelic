import assert from "node:assert/strict";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import { ConsoleLogger, LocalFileLogger, type Logger } from "@tracerelic/shared/logging";
import { CallerProbe } from "../../fixtures/caller-probe.ts";

interface CallerWorld {
  probe: CallerProbe;
  entry: { file: string; line: number; timestamp: string };
  pathError?: unknown;
}

function consoleWarning(stderr: string) {
  const fields = /^(\S+) WARN ([^\r\n]+):([1-9]\d*) ([^\r\n]*)\n$/.exec(stderr);
  assert(fields, stderr);
  return { timestamp: fields[1], file: fields[2], line: Number(fields[3]), message: fields[4] };
}

Before({ tags: "@log01 or @log02" }, async function (this: CallerWorld) {
  this.probe = await CallerProbe.create();
});

After({ tags: "@log01 or @log02" }, async function (this: CallerWorld) {
  await this.probe?.close();
});

Given(/^a command runs on (Bun running TypeScript|Node running JavaScript with source maps) and sends diagnostics to (the console|the local file)$/, function (
  this: CallerWorld, runtime: string, destination: string,
) {
  this.probe.runtime = runtime.startsWith("Bun") ? "bun" : "node";
  this.probe.destination = destination === "the console" ? "console" : "file";
});

When("the command reports {string}", async function (this: CallerWorld, message: string) {
  await this.probe.report(message);
});

Then("the console contains one warning with the message {string}", function (this: CallerWorld, message: string) {
  const entry = consoleWarning(this.probe.stderr);
  assert.equal(entry.message, message);
  this.entry = entry;
});

Then("the local file contains one warning with the message {string}", async function (this: CallerWorld, message: string) {
  assert.equal(this.probe.stdout, "");
  assert.equal(this.probe.stderr, "");
  const entries = await this.probe.entries();
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.partialDeepStrictEqual(entry, { level: "warn", message });
  assert(entry && typeof entry === "object" && "file" in entry && typeof entry.file === "string");
  assert("line" in entry && typeof entry.line === "number");
  assert("timestamp" in entry && typeof entry.timestamp === "string");
  this.entry = { file: entry.file, line: entry.line, timestamp: entry.timestamp };
});

Then("it identifies {string} at line {int}", function (this: CallerWorld, file: string, line: number) {
  assert.equal(this.entry.file, file);
  assert.equal(this.entry.line, line);
});

Then("its UTC timestamp falls between the start and end of the logging call", async function (this: CallerWorld) {
  const time = new Date(this.entry.timestamp);
  assert.equal(time.toISOString(), this.entry.timestamp);
  const { start, end } = await this.probe.times();
  assert(start <= time.getTime() && time.getTime() <= end);
});

Given("a command prints the JSON result {string}", function (this: CallerWorld, value: string) {
  this.probe.commandResult = value;
});

When("it also reports the warning {string} to the console", async function (this: CallerWorld, message: string) {
  await this.probe.report(message);
});

Then("standard output equals {string} followed by one line ending", function (this: CallerWorld, value: string) {
  assert.equal(this.probe.stdout, `${value}\n`);
});

Then("standard error contains exactly one warning", function (this: CallerWorld) {
  assert.equal(consoleWarning(this.probe.stderr).message, "History file skipped");
});

Given("a compiled command runs without source maps", async function (this: CallerWorld) {
  await this.probe.useUnmappedBuild();
});

Then("the entry identifies {string} at line {int}", function (this: CallerWorld, file: string, line: number) {
  const entry = consoleWarning(this.probe.stderr);
  assert.equal(entry.file, file);
  assert.equal(entry.line, line);
  assert.equal(entry.message, "Read failed");
});

Given("a previous logger wrote {string} and closed the file", async function (this: CallerWorld, message: string) {
  const logger = new LocalFileLogger({ filePath: this.probe.filePath });
  logger.warn(message);
  await logger.close();
});

When("a new logger writes {string} and {string} to that path and closes", async function (
  this: CallerWorld, first: string, second: string,
) {
  const logger = new LocalFileLogger({ filePath: this.probe.filePath });
  logger.warn(first);
  logger.warn(second);
  await logger.close();
});

Then("the file contains three JSON entries with messages {string}, {string}, and {string} in that order", async function (
  this: CallerWorld, first: string, second: string, third: string,
) {
  const entries = await this.probe.entries();
  assert.equal(entries.length, 3);
  for (const [i, message] of [first, second, third].entries()) {
    assert.partialDeepStrictEqual(entries[i], { level: "warn", message });
  }
});

When(/^the application constructs (a console logger|a file logger) with an empty (sourceRoot|filePath)$/, async function (
  this: CallerWorld, loggerType: string, option: string,
) {
  let logger: Logger;
  try {
    logger = loggerType === "a console logger" ? new ConsoleLogger({ sourceRoot: "" })
      : new LocalFileLogger({ filePath: this.probe.filePath, [option]: "" });
  } catch (error) {
    this.pathError = error;
    return;
  }
  await Promise.allSettled([logger.close()]);
});

Then("construction throws a TypeError for that path", function (this: CallerWorld) {
  assert(this.pathError instanceof TypeError, "Expected the constructor to throw TypeError");
});
