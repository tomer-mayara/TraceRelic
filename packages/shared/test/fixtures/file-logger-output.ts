import fs from "node:fs";
import { PassThrough } from "node:stream";
import type { TestContext } from "node:test";
import { LocalFileLogger } from "@tracerelic/shared/logging";

export class FileLoggerOutput {
  static capture(t: TestContext) {
    const stream = new PassThrough();
    t.after(() => { stream.destroy(); });
    stream.setEncoding("utf8");
    t.mock.method(fs, "createWriteStream", () => stream);
    return { stream, logger: new LocalFileLogger({ filePath: "error.log" }) };
  }
}
