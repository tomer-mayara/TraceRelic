import fs from "node:fs";
import { resolve } from "node:path";
import { Logger, type LogRecord } from "./logger.ts";

export class LocalFileLogger extends Logger {
  private readonly output: fs.WriteStream;
  private readonly fileClosed: Promise<void>;

  constructor({ filePath }: { filePath: string }) {
    super();
    const absolutePath = resolve(filePath);
    this.output = fs.createWriteStream(absolutePath, { flags: "a" });
    this.output.on("error", cause => {
      this.recordFailure(new Error(`Cannot write log file ${absolutePath}`, { cause }));
    });
    this.fileClosed = new Promise(done => this.output.once("close", done));
  }

  protected write(record: LogRecord): void {
    this.output.write(`${JSON.stringify(record)}\n`);
  }

  protected override finishWrites(): Promise<void> {
    this.output.end();
    return this.fileClosed;
  }
}
