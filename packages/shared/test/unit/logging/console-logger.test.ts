import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { ConsoleLogger, LogLevel, type Logger } from "@tracerelic/shared/logging";
import { ColorTerminal } from "../../fixtures/color-terminal.ts";
import { PendingStderr } from "../../fixtures/pending-stderr.ts";

test("each console level has its own foreground color and a foreground reset", async (t) => {
  const stderr = process.stderr;
  const interactive = stderr.isTTY && !process.env.CI;
  const useColor = interactive && !process.env.NO_COLOR && stderr.hasColors();
  const terminal = new ColorTerminal(t);
  const logger = new ConsoleLogger();
  logger.setLogLevel(LogLevel.Debug);
  logger.debug("message");
  logger.info("message");
  logger.warn("message");
  logger.error("message");
  await logger.close();

  const text: unknown = terminal.read();
  assert(typeof text === "string");
  const labels = text.trimEnd().split("\n").map(line => line.split(" ")[1]);
  assert.deepEqual(labels, [
    "\x1b[36mDEBUG\x1b[39m",
    "\x1b[32mINFO\x1b[39m",
    "\x1b[33mWARN\x1b[39m",
    "\x1b[31mERROR\x1b[39m",
  ]);
  if (interactive) stderr.write(useColor ? text : stripVTControlCharacters(text));
});

test("a nonempty NO_COLOR disables even forced color on the terminal", async (t) => {
  const terminal = new ColorTerminal(t, { NO_COLOR: "1", FORCE_COLOR: "1" });
  const logger = new ConsoleLogger();
  logger.error("message");
  await logger.close();

  const text: unknown = terminal.read();
  assert(typeof text === "string");
  assert.equal(text.split(" ")[1], "ERROR");
});

test("close stops new entries, waits for the pending console write, and leaves stderr open", async (t) => {
  const output = new PendingStderr(t);
  const logger: Logger = new ConsoleLogger();
  logger.error("message");

  let closed = false;
  const closing = logger.close().then(() => { closed = true; });
  assert.throws(() => logger.error("late"), /closed/i);
  await setImmediate();
  assert.equal(closed, false);

  output.release();
  await closing;
  assert.equal(output.writableEnded, false);
});
