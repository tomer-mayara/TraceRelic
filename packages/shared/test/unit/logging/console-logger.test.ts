import assert from "node:assert/strict";
import { errorMonitor } from "node:events";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { ConsoleLogger, LogLevel, type Logger } from "@tracerelic/shared/logging";
import { PendingStderr, replaceStderr } from "../../fixtures/stderr.ts";

function captureTerminal(t: TestContext, settings: NodeJS.ProcessEnv = {}) {
  const terminal = Object.assign(new PassThrough(), { isTTY: true });
  terminal.setEncoding("utf8");
  const restoreStderr = replaceStderr(terminal);
  const env = process.env;
  process.env = { ...env, TERM: "xterm-256color" };
  for (const key of ["CI", "FORCE_COLOR", "NO_COLOR", "NODE_DISABLE_COLORS"]) delete process.env[key];
  Object.assign(process.env, settings);
  t.after(() => {
    process.env = env;
    restoreStderr();
    terminal.destroy();
  });
  return terminal;
}

test("each console level has its own foreground color and a foreground reset", async (t) => {
  const stderr = process.stderr;
  const interactive = stderr.isTTY && !process.env.CI;
  const useColor = interactive && !process.env.NO_COLOR && stderr.hasColors();
  const terminal = captureTerminal(t);
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
  const terminal = captureTerminal(t, { NO_COLOR: "1", FORCE_COLOR: "1" });
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

test("a failed stderr write rejects every affected logger and releases its listener", async (t) => {
  const output = new PendingStderr(t);
  const loggers = [new ConsoleLogger(), new ConsoleLogger()];
  for (let i = 0; i < 12; i++) loggers[i % 2].warn("queued");
  const failure = new Error("write failed");
  const result = Promise.allSettled(loggers.map(logger => logger.close()));
  output.release(failure);
  assert.deepEqual(await result, [
    { status: "rejected", reason: failure }, { status: "rejected", reason: failure },
  ]);
  assert.equal(output.listenerCount("error"), 0);
  assert.equal(output.listenerCount(errorMonitor), 0);
  const unrelated = new Error("another writer failed");
  assert.throws(() => output.emit("error", unrelated), error => error === unrelated);
});

test("each console logger waits for its own writes on shared stderr", async (t) => {
  const output = new PendingStderr(t);
  const first = new ConsoleLogger();
  const second = new ConsoleLogger();
  first.warn("first");
  second.warn("second");
  const finished: string[] = [];
  const closing = Promise.all([
    first.close().then(() => finished.push("first")),
    second.close().then(() => finished.push("second")),
  ]);
  output.release();
  await setImmediate();
  assert.deepEqual(finished, ["first"]);
  output.release();
  await closing;
  assert.deepEqual(finished, ["first", "second"]);
});

test("other stderr errors keep their usual listeners while a failed write settles", async (t) => {
  const output = new PendingStderr(t);
  const logger = new ConsoleLogger();
  const failure = new Error("log write failed");
  const unrelated = new Error("command write failed");
  const handled = t.mock.fn();
  output.once("error", () => {
    assert.throws(() => output.emit("error", failure), error => error === failure);
    assert.throws(() => output.emit("error", unrelated), error => error === unrelated);
    output.prependOnceListener("error", handled);
    output.emit("error", unrelated);
  });
  logger.error("entry");
  const closed = assert.rejects(logger.close(), error => error === failure);
  output.release(failure);
  await closed;
  assert.deepEqual(handled.mock.calls[0]?.arguments, [unrelated]);
  assert.equal(output.listenerCount("error"), 0);
});

test("close waits for an earlier write when the next stderr write throws", async (t) => {
  const output = new PendingStderr(t);
  const logger = new ConsoleLogger();
  logger.warn("pending");
  const failure = new Error("next write failed");
  t.mock.method(output, "write", () => { throw failure; });
  logger.error("failure");
  const closing = logger.close();
  let settled = false;
  const result = assert.rejects(closing, error => error === failure).then(() => { settled = true; });
  assert.equal(logger.close(), closing);
  await setImmediate();
  assert.equal(settled, false);
  output.release();
  await result;
});
