import fs from "node:fs";
import { resolve } from "node:path";
import { Logger, type LoggerOptions, type LogRecord } from "./logger.ts";

export interface LocalFileLoggerOptions extends LoggerOptions {
  filePath: string;
}

export class LocalFileLogger extends Logger {
  private readonly output?: fs.WriteStream;
  private readonly fileClosed: Promise<void>;
  private readonly fileError: (cause: unknown) => void;
  private pendingWrites = 0;
  private onDrained?: () => void;

  constructor(options: LocalFileLoggerOptions) {
    super(options);
    if (options.filePath === "") throw new TypeError("filePath must not be empty");
    const absolutePath = resolve(options.filePath);
    this.fileError = cause => {
      const error = new Error(`Cannot write log file ${absolutePath}`, { cause });
      this.recordFailure(Object.assign(error, { filePath: absolutePath }));
    };
    let output: fs.WriteStream;
    try {
      output = fs.createWriteStream(absolutePath, { flags: "a" });
    } catch (cause) {
      this.fileError(cause);
      this.fileClosed = Promise.resolve();
      return;
    }
    this.output = output;
    output.on("error", this.fileError);
    this.fileClosed = new Promise(done => output.once("close", done));
  }

  protected write(record: LogRecord): void {
    if (!this.output) return;
    this.pendingWrites++;
    try {
      this.output.write(`${JSON.stringify(record)}\n`, this.writeDone);
    } catch (cause) {
      this.fileError(cause);
      this.writeDone();
    }
  }

  private readonly writeDone = (error?: Error | null): void => {
    if (error) this.fileError(error);
    this.pendingWrites--;
    if (this.pendingWrites === 0) this.onDrained?.();
  };

  protected override async finishWrites(): Promise<void> {
    try {
      this.output?.end();
    } catch (cause) {
      this.fileError(cause);
      if (this.pendingWrites > 0) await new Promise<void>(done => { this.onDrained = done; });
      this.output?.destroy();
    }
    await this.fileClosed;
  }
}
