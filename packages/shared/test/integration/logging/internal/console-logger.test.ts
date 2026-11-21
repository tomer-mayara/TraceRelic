import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { ConsoleLogger, LocalFileLogger, type Logger } from "@tracerelic/shared/logging";
import { logEachLevel } from "../../../fixtures/captured-logger.ts";
import { LoggingCommand } from "../../../fixtures/logging-command.ts";

const program = "integration/logging/internal/console-logger.test";
const [command, argument] = process.argv.slice(2);
if (command === "--error") {
  const logger: Logger = argument ? new LocalFileLogger({ filePath: argument }) : new ConsoleLogger();
  logger.error("message");
  if (argument) await logger.close();
} else if (command === "--log-levels") {
  const logger = new ConsoleLogger();
  logger.setLogLevel("debug");
  logEachLevel(logger);
  await logger.close();
} else {
  test("the default console writes an error with its caller and UTC time before close", async () => {
    const { stdout, stderr } = await LoggingCommand.run(program, ["--error"]);
    assert.equal(stdout, "");
    const [timestamp] = stderr.split(" ");
    assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    const file = `test/${program}.ts`;
    const source = await readFile(new URL(`../${file}`, import.meta.resolve("@tracerelic/shared")), "utf8");
    const line = source.split("\n").findIndex(text => text.trim() === 'logger.error("message");') + 1;
    assert(line > 0);
    assert.equal(stderr, `${timestamp} ERROR ${file}:${line} message\n`);
  });

  test("the console prints all four enabled levels to stderr in order", async () => {
    const { stdout, stderr } = await LoggingCommand.run(program, ["--log-levels"]);
    assert.equal(stdout, "");
    const lines = stderr.split("\n");
    assert.equal(lines.pop(), "");
    assert.deepEqual(lines.map(line => line.split(" ")[1]), ["DEBUG", "INFO", "WARN", "ERROR"]);
  });
}
