import assert from "node:assert/strict";
import { After, Given, Then, When } from "@cucumber/cucumber";
import { LogLevel } from "@tracerelic/shared/logging";
import { CapturedLogger, type LogDestination } from "../../fixtures/captured-logger.ts";

interface MessageScenario {
  capture: CapturedLogger;
  message: string;
  text: string;
  inputError?: unknown;
}

function consoleMessage(line: string): string {
  const fields = /^\S+ [A-Z]+ [^\r\n]+:[1-9]\d* ([^\r\n]*)$/.exec(line);
  assert(fields, line);
  return fields[1];
}

After({ tags: "@log03 or @log04" }, async function (this: MessageScenario) {
  await this.capture?.dispose();
});

Given(/^diagnostics go to (the console|the local file)$/, async function (this: MessageScenario, destination: LogDestination) {
  this.capture = await CapturedLogger.open(destination);
});

When("the application logs this message", function (this: MessageScenario, message: string) {
  this.message = message;
  this.capture.logger.warn(message);
});

Then(/^(?:the console|the local file) contains exactly one physical line$/, async function (this: MessageScenario) {
  this.text = await this.capture.text();
  const [, ...rest] = this.text.split(/\r\n|[\r\n]/);
  assert.deepEqual(rest, [""]);
});

Then("the console shows both parts with the line break written as text", function (this: MessageScenario) {
  assert.equal(consoleMessage(this.text.slice(0, -1)), this.message.replaceAll("\n", "\\n"));
});

Then("the decoded JSON message equals the input text", function (this: MessageScenario) {
  assert.partialDeepStrictEqual(JSON.parse(this.text), { message: this.message });
});

Given(/^a logger for (the console|the local file) with a minimum level of info$/, async function (
  this: MessageScenario, destination: LogDestination,
) {
  this.capture = await CapturedLogger.open(destination);
  this.capture.logger.setLogLevel(LogLevel.Info);
});

When("the application logs {string} at info level", function (this: MessageScenario, message: string) {
  this.capture.logger.info(message);
});

When(/^it calls logger\.setLogLevel\(LogLevel\.(Error|Debug)\)(?: on the same logger)?$/, function (
  this: MessageScenario, level: "Error" | "Debug",
) {
  this.capture.logger.setLogLevel(LogLevel[level]);
});

When("it logs {string} at warn level and {string} at error level", function (
  this: MessageScenario, warning: string, error: string,
) {
  this.capture.logger.warn(warning);
  this.capture.logger.error(error);
});

When("it logs {string} at debug level", function (this: MessageScenario, message: string) {
  this.capture.logger.debug(message);
});

Then(/^(the console|the local file) contains exactly "([^"]+)", "([^"]+)", and "([^"]+)" in that order$/, async function (
  this: MessageScenario, destination: LogDestination, first: string, second: string, third: string,
) {
  const lines = (await this.capture.text()).split("\n");
  assert.equal(lines.pop(), "");
  const messages = lines.map(line => destination === "the console" ? consoleMessage(line) : JSON.parse(line).message);
  assert.deepEqual(messages, [first, second, third]);
});

When("the application calls {word} with the JSON value {string}", function (
  this: MessageScenario, method: "info" | "setLogLevel", json: string,
) {
  const input: unknown = JSON.parse(json);
  try {
    Reflect.apply(this.capture.logger[method], this.capture.logger, [input]);
  } catch (error) {
    this.inputError = error;
  }
});

Then("the invalid input throws a TypeError", function (this: MessageScenario) {
  assert(this.inputError instanceof TypeError);
});

Then("the local file contains the single message {string}", async function (this: MessageScenario, message: string) {
  const [line, ...rest] = (await this.capture.text()).split("\n");
  assert.deepEqual(rest, [""]);
  assert.partialDeepStrictEqual(JSON.parse(line), { level: "info", message });
});

Then("the destination contains no log entries", async function (this: MessageScenario) {
  assert.equal(await this.capture.text(), "");
});
