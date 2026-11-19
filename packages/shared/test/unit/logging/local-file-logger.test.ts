import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { FileLoggerOutput } from "../../fixtures/file-logger-output.ts";

test("writes the warning message as one UTF-8 JSON line", (t) => {
  const { stream, logger } = FileLoggerOutput.capture(t);
  logger.warn("café");

  const text: unknown = stream.read();
  assert(typeof text === "string");
  const [line, ...rest] = text.split("\n");
  assert.deepEqual(rest, [""]);
  assert.partialDeepStrictEqual(JSON.parse(line), { level: "warn", message: "café" });
});

test("remembers a file open error until close", async (t) => {
  const { stream, logger } = FileLoggerOutput.capture(t);
  const failure = new Error("open failed");
  assert.doesNotThrow(() => stream.emit("error", failure));
  stream.destroy();

  await assert.rejects(logger.close(), (error: unknown) => {
    return error instanceof Error && error.message.includes(resolve("error.log")) && error.cause === failure;
  });
});
