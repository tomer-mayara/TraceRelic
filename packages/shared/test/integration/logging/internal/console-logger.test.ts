import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { ConsoleLogger, LocalFileLogger, LogLevel, type Logger } from "@tracerelic/shared/logging";
import { LoggingCommand } from "../../../fixtures/logging-command.ts";

async function logEachLevel(logger: Logger): Promise<void> {
  logger.debug("message");
  logger.info("message");
  logger.warn("message");
  logger.error("message");
  await logger.close();
}

const [command, minimum, filePath] = process.argv.slice(2);
if (command === "--log-levels") {
  const logger: Logger = filePath ? new LocalFileLogger({ filePath }) : new ConsoleLogger();
  if (minimum === "LogLevel.Warn") logger.setLogLevel(LogLevel.Warn);
  if (minimum === "warn" || minimum === "debug") logger.setLogLevel(minimum);
  await logEachLevel(logger);
} else {
  for (const runtime of ["bun", "node"] as const) {
    test(`ConsoleLogger on ${runtime} writes the error with its caller and UTC time to stderr`, async () => {
      const result = await LoggingCommand.run(runtime, "fixtures/console-error");
      assert.ifError(result.error);
      assert.equal(result.stdout, "");
      const [timestamp] = result.stderr.split(" ");
      assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.equal(result.stderr, `${timestamp} ERROR test/fixtures/console-error.ts:4 message\n`);
    });
  }

  test("the console prints all four enabled levels in order", async (t) => {
    const writes = t.mock.method(process.stderr, "write");
    const logger = new ConsoleLogger();
    logger.setLogLevel(LogLevel.Debug);
    await logEachLevel(logger);
    const labels = writes.mock.calls.map(call => stripVTControlCharacters(String(call.arguments[0])).split(" ")[1]);
    assert.deepEqual(labels, ["DEBUG", "INFO", "WARN", "ERROR"]);
  });
}
