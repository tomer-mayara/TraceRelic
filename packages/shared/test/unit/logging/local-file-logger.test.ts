import assert from "node:assert/strict";
import fs from "node:fs";
import { resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { LocalFileLogger } from "@tracerelic/shared/logging";

function openFile(t: TestContext, stream: Writable): LocalFileLogger {
  t.mock.method(fs, "createWriteStream", () => stream);
  t.after(() => { stream.destroy(); });
  return new LocalFileLogger({ filePath: "error.log" });
}

function captureFile(t: TestContext, highWaterMark?: number) {
  const stream = new PassThrough({ highWaterMark });
  stream.setEncoding("utf8");
  return { stream, logger: openFile(t, stream) };
}

function failingFile(t: TestContext, failures: { write?: Error; close?: Error }) {
  return openFile(t, new Writable({
    write(_chunk, _encoding, done) { done(failures.write); },
    destroy(error, done) { done(failures.close ?? error); },
  }));
}

test("writes the warning message as one UTF-8 JSON line", (t) => {
  const { stream, logger } = captureFile(t);
  logger.warn("café");

  const text: unknown = stream.read();
  assert(typeof text === "string");
  const [line, ...rest] = text.split("\n");
  assert.deepEqual(rest, [""]);
  assert.partialDeepStrictEqual(JSON.parse(line), { level: "warn", message: "café" });
});

test("remembers a file open error until close", async (t) => {
  const { stream, logger } = captureFile(t);
  const failure = new Error("open failed");
  assert.doesNotThrow(() => stream.emit("error", failure));
  stream.destroy();

  await assert.rejects(logger.close(), (error: unknown) => {
    return error instanceof Error && error.message.includes(resolve("error.log")) &&
      "filePath" in error && error.filePath === resolve("error.log") && error.cause === failure;
  });
});

test("close reports a synchronous file open failure and keeps its cause", async (t) => {
  const failure = new Error("open threw");
  const open = t.mock.method(fs, "createWriteStream", () => { throw failure; });
  const filePath = resolve("error.log");
  const logger = new LocalFileLogger({ filePath });
  logger.error("unwritable");
  await assert.rejects(logger.close(), (error: unknown) =>
    error instanceof Error && error.cause === failure && "filePath" in error && error.filePath === filePath);
  assert.equal(open.mock.callCount(), 1);
});

test("close waits for the last file write and preserves the time of the call", async (t) => {
  const start = new Date("2026-01-01T00:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const { stream, logger } = captureFile(t, 1);
  logger.warn("Last entry");
  let closed = false;
  const closing = logger.close().then(() => { closed = true; });
  t.mock.timers.tick(1_000);
  await setImmediate();
  assert.equal(stream.writableFinished, false);
  assert.equal(closed, false);

  const text: unknown = stream.read();
  assert(typeof text === "string");
  assert.partialDeepStrictEqual(JSON.parse(text), { timestamp: start.toISOString(), message: "Last entry" });
  stream.resume();
  await closing;
  assert.equal(stream.closed, true);
});

for (const operation of ["write", "close"] as const) {
  test(`close reports the path and original cause of a file ${operation} failure`, async (t) => {
    const failure = new Error(`${operation} failed`);
    const logger = failingFile(t, { [operation]: failure });
    logger.warn("accepted");
    const closing = logger.close();
    assert.equal(logger.close(), closing);
    await assert.rejects(closing, (error: unknown) =>
      error instanceof Error && error.cause === failure && "filePath" in error && error.filePath === resolve("error.log"));
  });
}

test("a file close failure does not replace the previous write failure", async (t) => {
  const write = new Error("write failed");
  const logger = failingFile(t, { write, close: new Error("close failed") });
  logger.error("entry");
  await assert.rejects(logger.close(), error => error instanceof Error && error.cause === write);
});

test("a synchronous file write error keeps the path, cause, and other entries", async (t) => {
  const { stream, logger } = captureFile(t);
  const failure = new Error("write threw");
  logger.info("First");
  const rejectWrite = t.mock.method(stream, "write", () => { throw failure; });
  logger.warn("Rejected");
  rejectWrite.mock.restore();
  logger.info("Last");

  const text: unknown = stream.read();
  assert(typeof text === "string");
  stream.resume();
  await assert.rejects(logger.close(), error => error instanceof Error && error.cause === failure &&
    "filePath" in error && error.filePath === resolve("error.log"));
  assert.deepEqual(text.trimEnd().split("\n").map(line => JSON.parse(line).message), ["First", "Last"]);
  assert.equal(stream.closed, true);
});

test("an end call that throws finishes accepted writes and closes the stream before reporting its error", async (t) => {
  const { stream, logger } = captureFile(t, 1);
  const failure = new Error("end threw");
  t.mock.method(stream, "end", () => { throw failure; });
  logger.info("First");
  logger.info("Second");

  let settled = false;
  let reported: unknown;
  const closing = logger.close().then(
    () => { settled = true; },
    (error: unknown) => { settled = true; reported = error; },
  );
  await setImmediate();
  assert.equal(settled, false);
  let text = "";
  stream.on("data", (chunk: string) => { text += chunk; });
  stream.resume();
  await closing;

  assert.deepEqual(text.trimEnd().split("\n").map(line => JSON.parse(line).message), ["First", "Second"]);
  assert.equal(stream.closed, true);
  assert(reported instanceof Error && reported.cause === failure);
  assert.equal("filePath" in reported && reported.filePath, resolve("error.log"));
});
