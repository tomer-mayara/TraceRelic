import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { LocalFileLogger, type Logger } from "@tracerelic/shared/logging";
import { CallerStack } from "../../fixtures/caller-stack.ts";
import { CapturedLogger } from "../../fixtures/captured-logger.ts";

test("close makes the error entry available to read from the local file", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "tracerelic-file-logger-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = join(directory, "errors.jsonl");
  const logger: Logger = new LocalFileLogger({ filePath });
  logger.error("message");
  await logger.close();

  const record: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  assert.partialDeepStrictEqual(record, { level: "error", message: "message" });
});

test("close reports a failed file open with the resolved path and filesystem error", async () => {
  const filePath = "invalid\0log";
  const logger = new LocalFileLogger({ filePath });
  logger.warn("Could not open the destination");
  const closing = logger.close();
  assert.equal(logger.close(), closing);
  await assert.rejects(closing, (error: unknown) => {
    assert(error instanceof Error);
    assert.equal("filePath" in error && error.filePath, resolve(filePath));
    assert(error.cause instanceof Error);
    assert.equal("code" in error.cause && error.cause.code, "ERR_INVALID_ARG_VALUE");
    return true;
  });
});

test("a single JSON line restores every character of the file and message", async (t) => {
  const capture = await CapturedLogger.open("the local file");
  t.after(() => capture.dispose());
  const file = "src/a\rb\nc\r\nd.ts";
  const message = 'one\r"two"\nthree\\four\r\nfive';
  CallerStack.during([{ scriptName: pathToFileURL(resolve(file)).href, lineNumber: 42 }], () => {
    capture.logger.warn(message);
  });

  const [line, ...rest] = (await capture.text()).split(/\r\n|[\r\n]/);
  assert.deepEqual(rest, [""]);
  assert.partialDeepStrictEqual(JSON.parse(line), { file, line: 42, message });
});
