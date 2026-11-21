import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { After, Given, Then, When, type DataTable } from "@cucumber/cucumber";
import { LogLevel } from "@tracerelic/shared/logging";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { CapturedLogger, logEachLevel, type LogDestination } from "../../fixtures/captured-logger.ts";
import { LoggingCommand, type StderrMode } from "../../fixtures/logging-command.ts";

const program = "integration/logging/internal/console-logger.test";
const sharedRoot = new URL("../", import.meta.resolve("@tracerelic/shared"));
const levelsSource = "test/fixtures/captured-logger.ts";
const sourceLines = (await readFile(new URL(levelsSource, sharedRoot), "utf8")).split("\n");

function callLine(level: string): number {
  const line = sourceLines.findIndex(text => text.trim() === `logger.${level}("message");`) + 1;
  assert(line > 0, `Missing ${level} call in ${levelsSource}`);
  return line;
}

function assertConsoleLine(line: string, level: string, label = level.toUpperCase()): void {
  const [timestamp] = line.split(" ");
  assert.equal(new Date(timestamp).toISOString(), timestamp);
  assert.equal(line, `${timestamp} ${label} ${levelsSource}:${callLine(level)} message`);
}

interface LoggingScenario {
  logging: typeof import("@tracerelic/shared/logging");
  destination: LogDestination;
  filePath: string;
  stderrMode?: StderrMode;
  execution: ReturnType<typeof LoggingCommand.run>;
  levelLogger: CapturedLogger;
  text: string;
}

Given("standard error is a terminal with color enabled", function (this: LoggingScenario) {
  this.stderrMode = "terminal";
});

Given('standard error is a terminal and NO_COLOR is set to "1"', function (this: LoggingScenario) {
  this.stderrMode = "no-color-terminal";
});

Given("standard error goes to a pipe", function (this: LoggingScenario) {
  this.stderrMode = "pipe";
});

When("a console logger set to debug logs one message at each level", function (this: LoggingScenario) {
  this.execution = LoggingCommand.run(program, ["--log-levels"], this.stderrMode);
});

Then("only the level labels have the following foreground colors", async function (this: LoggingScenario, table: DataTable) {
  const foreground: Record<string, number> = { cyan: 36, green: 32, yellow: 33, red: 31 };
  const rows = table.hashes();
  const result = await this.execution;
  assert.equal(result.stdout, "");
  const lines = result.stderr.split("\n");
  assert.equal(lines.pop(), "");
  assert.equal(lines.length, rows.length);
  for (const [i, { label, color }] of rows.entries()) {
    const coloredLabel = `\u001b[${foreground[color]}m${label}\u001b[39m`;
    assertConsoleLine(lines[i], label.toLowerCase(), coloredLabel);
  }
});

When("the application imports the shared logging package", async function (this: LoggingScenario) {
  this.logging = await import("@tracerelic/shared/logging");
});

Then("its LogLevel enum has these numeric severities", function (this: LoggingScenario, table: DataTable) {
  for (const { member, severity } of table.hashes()) {
    assert.equal(Reflect.get(this.logging.LogLevel, member), Number(severity), `LogLevel.${member}`);
  }
});

Given("a default console logger", function (this: LoggingScenario) {
  this.destination = "the console";
});

Given("a local file logger for a new temporary log file", async function (this: LoggingScenario) {
  this.destination = "the local file";
  const directory = await mkdtemp(join(tmpdir(), "tracerelic-logging-"));
  this.filePath = join(directory, "events.jsonl");
});

After({ tags: "@log00b or @log03" }, async function (this: LoggingScenario) {
  await this.levelLogger?.dispose();
  if (this.filePath) await rm(dirname(this.filePath), { recursive: true, force: true });
});

When(/^the application calls logger\.error\("message"\)$/, function (this: LoggingScenario) {
  const args = this.destination === "the local file" ? ["--error", this.filePath] : ["--error"];
  this.execution = LoggingCommand.run(program, args, this.stderrMode);
});

Given(/^(the console|the local file) uses (?:the default minimum|a minimum level of (warn|debug|LogLevel\.Warn))$/, async function (
  this: LoggingScenario, destination: LogDestination, minimum?: "warn" | "debug" | "LogLevel.Warn",
) {
  this.destination = destination;
  this.levelLogger = await CapturedLogger.open(destination, { sourceRoot: fileURLToPath(sharedRoot) });
  if (minimum) this.levelLogger.logger.setLogLevel(minimum === "LogLevel.Warn" ? LogLevel.Warn : minimum);
});

Given(/^(the console|the local file) is constructed with a minimum level of warn$/, async function (
  this: LoggingScenario, destination: LogDestination,
) {
  this.destination = destination;
  this.levelLogger = await CapturedLogger.open(destination, {
    sourceRoot: fileURLToPath(sharedRoot), minLevel: destination === "the console" ? LogLevel.Warn : "warn",
  });
});

When("the application calls debug, info, warn, and error with only a message", async function (this: LoggingScenario) {
  const quietStreams = this.destination === "the console" ? [process.stdout] : [process.stdout, process.stderr];
  const writes = quietStreams.map(stream => mock.method(stream, "write"));
  try {
    logEachLevel(this.levelLogger.logger);
    this.text = await this.levelLogger.text();
    for (const write of writes) assert.equal(write.mock.callCount(), 0);
  } finally {
    for (const write of writes) write.mock.restore();
  }
});

Then(/^(?:the console|the local file) contains exactly ([a-z, ]+) in that order$/, function (
  this: LoggingScenario, levels: string,
) {
  const expected = levels.split(", ");
  const lines = this.text.split("\n");
  assert.equal(lines.pop(), "");
  assert.equal(lines.length, expected.length);
  for (const [i, level] of expected.entries()) {
    if (this.destination === "the local file") {
      const entry: unknown = JSON.parse(lines[i]);
      assert.partialDeepStrictEqual(entry, { level, file: levelsSource, line: callLine(level), message: "message" });
      assert(entry && typeof entry === "object" && "timestamp" in entry && typeof entry.timestamp === "string");
      assert.equal(new Date(entry.timestamp).toISOString(), entry.timestamp);
    } else {
      assertConsoleLine(lines[i], level);
    }
  }
});

When("the application waits for the logger to close", async function (this: LoggingScenario) {
  await this.execution;
});

Then("standard error contains exactly one log line with the label {string} and the message {string}", async function (
  this: LoggingScenario, label: string, message: string,
) {
  const result = await this.execution;
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, stripVTControlCharacters(result.stderr));
  const fields = /^\S+ (?<label>[A-Z]+) [^\r\n]+:[1-9]\d* (?<message>[^\r\n]*)\n$/.exec(result.stderr)?.groups;
  assert(fields, result.stderr);
  assert.equal(fields.label, label);
  assert.equal(fields.message, message);
});

Then("the file contains exactly one JSON line with level {string} and message {string}", async function (
  this: LoggingScenario, level: string, message: string,
) {
  const schemaFile = new URL("../../../dist/shared-logging/logging.schema.json", import.meta.resolve("@tracerelic/shared"));
  const schema: unknown = JSON.parse(await readFile(schemaFile, "utf8"));
  assert(schema && typeof schema === "object" && "$schema" in schema && typeof schema.$schema === "string");
  const contract = new Ajv2020({ formats: fullFormats }).addSchema({ ...schema, $schema: schema.$schema });

  assert(this.filePath);
  const [line, ...rest] = (await readFile(this.filePath, "utf8")).split("\n");
  assert.deepEqual(rest, [""]);
  const record: unknown = JSON.parse(line);
  assert(contract.validate("LogRecord.json", record), contract.errorsText());
  assert.partialDeepStrictEqual(record, { level, message });
});

Then("standard output and standard error are empty", async function (this: LoggingScenario) {
  const result = await this.execution;
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
