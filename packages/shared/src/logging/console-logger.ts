import { styleText } from "node:util";
import { Logger, type LogRecord } from "./logger.ts";

const levelColors = {
  debug: "cyan",
  info: "green",
  warn: "yellow",
  error: "red",
} as const;

export class ConsoleLogger extends Logger {
  private lastWrite = Promise.resolve();

  protected write({ timestamp, level, file, line, message }: LogRecord): void {
    const stderr = process.stderr;
    const name = level.toUpperCase();
    const label = stderr.isTTY && !process.env.NO_COLOR
      ? styleText(levelColors[level], name, { stream: stderr })
      : name;
    const entry = `${timestamp} ${label} ${file}:${line} ${message}\n`;
    this.lastWrite = new Promise(done => {
      stderr.write(entry, error => {
        if (error) this.recordFailure(error);
        done();
      });
    });
  }

  protected override finishWrites(): Promise<void> {
    return this.lastWrite;
  }
}
