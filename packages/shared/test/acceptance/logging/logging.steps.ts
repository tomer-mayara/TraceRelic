import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { After, Given, Then, When, setWorldConstructor, type DataTable } from "@cucumber/cucumber";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { LoggingCommand, type LoggingProgram, type StderrMode } from "../../fixtures/logging-command.ts";

const levelsProgram = "integration/logging/internal/console-logger.test";
const levelsSource = `test/${levelsProgram}.ts`;
const callLines: Record<string, number> = { debug: 8, info: 9, warn: 10, error: 11 };

class LoggingScenario {
  logging!: typeof import("@tracerelic/shared/logging");
  program!: LoggingProgram;
  directory?: string;
  minimum = "default";
  stderrMode?: StderrMode;
  filePaths: string[] = [];
  runs!: ReturnType<typeof LoggingCommand.run>[];

  async useFile() {
    this.directory = await mkdtemp(join(tmpdir(), "tracerelic-logging-"));
  }

  start(...args: string[]) {
    this.runs = (["node", "bun"] as const).map(runtime => {
      if (!this.directory) return LoggingCommand.run(runtime, this.program, args, this.stderrMode);
      const filePath = join(this.directory, `${runtime}.jsonl`);
      this.filePaths.push(filePath);
      return LoggingCommand.run(runtime, this.program, [...args, filePath]);
    });
  }
}
setWorldConstructor(LoggingScenario);

Given("standard error is a terminal with color enabled", function (this: LoggingScenario) {
  this.stderrMode = "terminal";
});

Given('standard error is a terminal and NO_COLOR is set to "1"', function (this: LoggingScenario) {
  this.stderrMode = "no-color-terminal";
});

Given("standard error goes to a pipe", function (this: LoggingScenario) {
  this.stderrMode = "pipe";
});

Then("only the level labels have the following foreground colors", async function (this: LoggingScenario, table: DataTable) {
  const foreground: Record<string, number> = { cyan: 36, green: 32, yellow: 33, red: 31 };
  const rows = table.hashes();
  for (const result of await Promise.all(this.runs)) {
    assert.ifError(result.error);
    assert.equal(result.stdout, "");
    const lines = result.stderr.split("\n");
    assert.equal(lines.pop(), "");
    assert.equal(lines.length, rows.length);
    for (const [i, { label, color }] of rows.entries()) {
      const [timestamp] = lines[i].split(" ");
      assert.equal(new Date(timestamp).toISOString(), timestamp);
      const coloredLabel = `\u001b[${foreground[color]}m${label}\u001b[39m`;
      assert.equal(lines[i], `${timestamp} ${coloredLabel} ${levelsSource}:${callLines[label.toLowerCase()]} message`);
    }
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
  this.program = "fixtures/console-error";
});

Given("a local file logger for a new temporary log file", async function (this: LoggingScenario) {
  this.program = "fixtures/file-error";
  await this.useFile();
});

After(async function (this: LoggingScenario) {
  if (this.directory) await rm(this.directory, { recursive: true, force: true });
});

When(/^the application calls logger\.error\("message"\)$/, function (this: LoggingScenario) {
  this.start();
});

Given(/^(the console|the local file) uses (?:the default minimum|a minimum level of (warn|debug|LogLevel\.Warn))$/, async function (
  this: LoggingScenario, destination: string, minimum?: string,
) {
  this.program = levelsProgram;
  if (destination === "the local file") await this.useFile();
  if (minimum) this.minimum = minimum;
});

When("the application calls debug, info, warn, and error with only a message", function (this: LoggingScenario) {
  this.start("--log-levels", this.minimum);
});

Then(/^(?:the console|the local file) contains exactly ([a-z, ]+) in that order$/, async function (
  this: LoggingScenario, levels: string,
) {
  const expected = levels.split(", ");
  for (const [index, result] of (await Promise.all(this.runs)).entries()) {
    assert.ifError(result.error);
    assert.equal(result.stdout, "");
    const filePath = this.filePaths[index];
    if (filePath) assert.equal(result.stderr, "");
    const text = filePath ? await readFile(filePath, "utf8") : result.stderr;
    const lines = text.split("\n");
    assert.equal(lines.pop(), "");
    assert.equal(lines.length, expected.length);
    for (const [i, level] of expected.entries()) {
      if (filePath) {
        const entry: unknown = JSON.parse(lines[i]);
        assert.partialDeepStrictEqual(entry, { level, file: levelsSource, line: callLines[level], message: "message" });
        assert(entry && typeof entry === "object" && "timestamp" in entry && typeof entry.timestamp === "string");
        assert.equal(new Date(entry.timestamp).toISOString(), entry.timestamp);
      } else {
        const [timestamp] = lines[i].split(" ");
        assert.equal(new Date(timestamp).toISOString(), timestamp);
        assert.equal(lines[i], `${timestamp} ${level.toUpperCase()} ${levelsSource}:${callLines[level]} message`);
      }
    }
  }
});

When("the application waits for the logger to close", async function (this: LoggingScenario) {
  for (const result of await Promise.all(this.runs)) assert.ifError(result.error);
});

Then("standard error contains exactly one log line with the label {string} and the message {string}", async function (
  this: LoggingScenario, label: string, message: string,
) {
  for (const result of await Promise.all(this.runs)) {
    assert.ifError(result.error);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, stripVTControlCharacters(result.stderr));
    const fields = /^\S+ (?<label>[A-Z]+) [^\r\n]+:[1-9]\d* (?<message>[^\r\n]*)\n$/.exec(result.stderr)?.groups;
    assert(fields, result.stderr);
    assert.equal(fields.label, label);
    assert.equal(fields.message, message);
  }
});

Then("the file contains exactly one JSON line with level {string} and message {string}", async function (
  this: LoggingScenario, level: string, message: string,
) {
  const schemaFile = new URL("../../../dist/shared-logging/logging.schema.json", import.meta.resolve("@tracerelic/shared"));
  const schema: unknown = JSON.parse(await readFile(schemaFile, "utf8"));
  assert(schema && typeof schema === "object" && "$schema" in schema && typeof schema.$schema === "string");
  const contract = new Ajv2020({ formats: fullFormats }).addSchema({ ...schema, $schema: schema.$schema });

  for (const filePath of this.filePaths) {
    const [line, ...rest] = (await readFile(filePath, "utf8")).split("\n");
    assert.deepEqual(rest, [""]);
    const record: unknown = JSON.parse(line);
    assert(contract.validate("LogRecord.json", record), contract.errorsText());
    assert.partialDeepStrictEqual(record, { level, message });
  }
});

Then("standard output and standard error are empty", async function (this: LoggingScenario) {
  for (const result of await Promise.all(this.runs)) {
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
});
