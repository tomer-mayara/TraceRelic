import assert from "node:assert/strict";
import { test } from "node:test";
import util from "node:util";
import { ConsoleLogger, LogLevel } from "@tracerelic/shared/logging";
import { PendingStderr } from "../../fixtures/stderr.ts";
import { RecordingLogger } from "../../fixtures/recording-logger.ts";

test("each constructor threshold takes effect on its first call", () => {
  const quiet = new RecordingLogger({ minLevel: "warn" });
  const verbose = new RecordingLogger({ minLevel: LogLevel.Debug });
  quiet.info("below warn");
  quiet.warn("first warning");
  verbose.debug("first details");
  quiet.setLogLevel(LogLevel.Error);
  quiet.warn("below error");
  verbose.debug("more details");

  assert.deepEqual(quiet.records.map(record => record.message), ["first warning"]);
  assert.deepEqual(verbose.records.map(record => record.message), ["first details", "more details"]);
});

test("a suppressed call skips caller capture", async (t) => {
  const logger = new RecordingLogger();
  const capture = t.mock.method(util, "getCallSites", () => []);
  logger.debug("below info");
  await logger.close();
  assert.equal(capture.mock.callCount(), 0);
  assert.deepEqual(logger.records, []);
});

test("constructors and setters reject values outside the public severities", () => {
  const logger = new RecordingLogger({ minLevel: LogLevel.Error });
  for (const invalid of [6, 0, NaN, "warning", "toString", null]) {
    assert.throws(() => Reflect.construct(RecordingLogger, [{ minLevel: invalid }]), TypeError);
    assert.throws(() => Reflect.apply(logger.setLogLevel, logger, [invalid]), TypeError);
  }
  logger.warn("quiet");
  logger.error("visible");
  assert.deepEqual(logger.records.map(record => record.message), ["visible"]);
});

test("each method rejects a non-string message before caller capture", async (t) => {
  const logger = new RecordingLogger();
  const capture = t.mock.method(util, "getCallSites", () => []);
  for (const method of ["debug", "info", "warn", "error"] as const) {
    assert.throws(() => Reflect.apply(logger[method], logger, [{}]), TypeError);
  }
  assert.equal(capture.mock.callCount(), 0);
  await logger.close();
  assert.deepEqual(logger.records, []);
});

test("raising the minimum preserves an accepted write while it is pending", async (t) => {
  const output = new PendingStderr(t);
  const writes = t.mock.method(output, "_write");
  const logger = new ConsoleLogger();
  logger.info("before");
  logger.setLogLevel(LogLevel.Error);
  logger.warn("quiet");
  const closed = logger.close();
  output.release();
  await closed;

  assert.equal(writes.mock.callCount(), 1);
  assert.match(writes.mock.calls[0].arguments[0].toString(), / INFO .* before\n$/);
});
