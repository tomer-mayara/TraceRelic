import { errorMonitor } from "node:events";
import { setImmediate } from "node:timers/promises";
import { styleText } from "node:util";
import { Logger, type LogRecord } from "./logger.ts";

const levelColors = {
  debug: "cyan",
  info: "green",
  warn: "yellow",
  error: "red",
} as const;

export class ConsoleLogger extends Logger {
  private static readonly writeErrors = new WeakMap<NodeJS.WriteStream, { errors: Set<Error>; settled: Promise<void> }>();
  private readonly pending = new Set<Promise<void>>();

  protected write({ timestamp, level, file, line, message }: LogRecord): void {
    const stderr = process.stderr;
    const name = level.toUpperCase();
    const label = stderr.isTTY && !process.env.NO_COLOR
      ? styleText(levelColors[level], name, { stream: stderr })
      : name;
    const location = `${ConsoleLogger.escapeLineBreaks(file)}:${line}`;
    const entry = `${timestamp} ${label} ${location} ${ConsoleLogger.escapeLineBreaks(message)}\n`;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise));
    try {
      stderr.write(entry, error => {
        if (!error) return resolve();
        this.recordFailure(error);
        resolve(ConsoleLogger.waitForErrorEvent(stderr, error));
      });
    } catch (error) {
      this.recordFailure(error);
      resolve();
    }
  }

  protected override async finishWrites(): Promise<void> {
    await Promise.all(this.pending);
  }

  private static escapeLineBreaks(text: string): string {
    return text.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
  }

  private static waitForErrorEvent(stream: NodeJS.WriteStream, error: Error): Promise<void> {
    const pending = this.writeErrors.get(stream);
    if (pending) {
      pending.errors.add(error);
      return pending.settled;
    }
    const errors = new Set([error]);
    // The stream can emit the callback's error before the next event loop turn.
    const monitor = (reported: Error) => {
      if (errors.delete(reported) && stream.listenerCount("error") === 0) stream.once("error", () => {});
    };
    stream.on(errorMonitor, monitor);
    const settled = setImmediate().then(() => {
      stream.off(errorMonitor, monitor);
      this.writeErrors.delete(stream);
    });
    this.writeErrors.set(stream, { errors, settled });
    return settled;
  }
}
