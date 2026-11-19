import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalFileLogger, type Logger } from "@tracerelic/shared/logging";

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
