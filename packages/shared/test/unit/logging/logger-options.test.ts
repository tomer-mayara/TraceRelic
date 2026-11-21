import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { ConsoleLogger, LocalFileLogger } from "@tracerelic/shared/logging";

for (const [option, construct] of [
  ["ConsoleLogger.sourceRoot", () => new ConsoleLogger({ sourceRoot: "" })],
  ["LocalFileLogger.sourceRoot", () => new LocalFileLogger({ filePath: "log.jsonl", sourceRoot: "" })],
  ["LocalFileLogger.filePath", () => new LocalFileLogger({ filePath: "" })],
] as const) {
  test(`${option} rejects an empty path before opening a file`, (t) => {
    const open = t.mock.method(fs, "createWriteStream", () => { throw new Error("unexpected file open"); });
    assert.throws(construct, TypeError);
    assert.equal(open.mock.callCount(), 0);
  });
}
