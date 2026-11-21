import assert from "node:assert/strict";
import { test } from "node:test";
import { LogLevel, type Logger, type LogRecord } from "@tracerelic/shared/logging";
import { RecordingLogger } from "../../fixtures/recording-logger.ts";

test("each message method supplies its severity, call time and caller", () => {
  const recording = new RecordingLogger();
  const logger: Logger = recording;
  const before = Date.now();
  logger.info("Listening");
  logger.setLogLevel(LogLevel.Debug);
  logger.debug("Read settings");
  logger.warn("Retrying");
  logger.error("Request failed");
  const after = Date.now();

  assert.deepEqual(recording.records.map(({ level, message }) => [level, message]), [
    ["info", "Listening"],
    ["debug", "Read settings"],
    ["warn", "Retrying"],
    ["error", "Request failed"],
  ]);
  for (const record of recording.records) {
    const time = Date.parse(record.timestamp);
    assert.ok(before <= time && time <= after);
    assert.equal(record.timestamp, new Date(time).toISOString());
    assert.match(record.file, /(?:^|\/)logger\.test\.ts$/);
    assert.ok(Number.isInteger(record.line) && record.line > 0);
  }
});

test("Warn accepts warnings and errors for both its numeric value and lowercase name", () => {
  assert.deepEqual([LogLevel.Debug, LogLevel.Info, LogLevel.Warn, LogLevel.Error], [2, 3, 4, 5]);
  for (const minimum of [LogLevel.Warn, "warn"] as const) {
    const recording = new RecordingLogger();
    const logger: Logger = recording;
    logger.setLogLevel(minimum);
    logger.debug("details");
    logger.info("started");
    logger.warn("retrying");
    logger.error("failed");
    assert.deepEqual(recording.records.map(record => record.level), ["warn", "error"]);
  }
});

test("the minimum severity changes only for the selected logger", () => {
  const changed = new RecordingLogger();
  const other = new RecordingLogger();
  changed.debug("below the default");
  changed.info("before");
  changed.setLogLevel(LogLevel.Error);
  changed.warn("below error");
  changed.error("failure");
  other.info("visible");
  changed.setLogLevel(LogLevel.Debug);
  changed.debug("details");
  other.debug("still below the default");

  assert.deepEqual(changed.records.map(record => record.message), ["before", "failure", "details"]);
  assert.deepEqual(other.records.map(record => record.message), ["visible"]);
});

test("all severity methods and the level setter reject calls after close starts", async () => {
  const logger: Logger = new RecordingLogger();
  const closed = logger.close();
  for (const method of ["debug", "info", "warn", "error"] as const) {
    assert.throws(() => logger[method]("late"), /closed/i);
  }
  assert.throws(() => logger.setLogLevel(LogLevel.Debug), /closed/i);
  await closed;
  assert.throws(() => logger.error("late"), /closed/i);
  assert.throws(() => logger.setLogLevel(LogLevel.Debug), /closed/i);
});

test("close blocks reentry during shutdown and keeps the first failure", async () => {
  const earlier = new Error("previous failure");
  const later = new Error("finish failed");
  let reentryError: unknown;
  const logger = new class extends RecordingLogger {
    protected override write(): void { throw earlier; }

    protected override finishWrites(): Promise<void> {
      try {
        this.info("while finishing");
      } catch (error) {
        reentryError = error;
      }
      throw later;
    }
  }();
  logger.error("before close");
  const closing = logger.close();
  assert.equal(logger.close(), closing);
  await assert.rejects(closing, error => error === earlier);
  assert(reentryError instanceof Error);
  assert.match(reentryError.message, /closed/i);
});

test("a destination can reject one write and still accept the next entry", async () => {
  const original = new Error("Destination rejected this entry");
  const diagnostic = Proxy.revocable({}, {});
  diagnostic.revoke();
  const failures: unknown[] = [original, "write refused", Object.create(null), diagnostic.proxy];
  for (const failure of failures) {
    const logger = new class extends RecordingLogger {
      protected override write(record: LogRecord): void {
        if (record.message === "Rejected") throw failure;
        super.write(record);
      }
    }();
    logger.info("First");
    logger.warn("Rejected");
    logger.info("Last");
    const closing = logger.close();
    assert.equal(logger.close(), closing);
    await assert.rejects(closing, (error: unknown) => {
      if (failure === original) return error === original;
      assert(error instanceof Error);
      assert.equal(error.cause, failure);
      if (typeof failure === "string") assert.equal(error.message, failure);
      return true;
    });
    assert.deepEqual(logger.records.map(record => record.message), ["First", "Last"]);
  }
});
