import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import util from "node:util";
import { Logger as TsLogger, LogLevel as TsLogLevel } from "tslog";

// The pinned runtimes provide Error.isError. The workspace uses ES2022 type definitions.
const { isError } = Error as ErrorConstructor & { isError(value: unknown): value is Error };

// Source and compiled callers can report either path for the base logger.
const loggerFiles = new Set([
  fileURLToPath(import.meta.url),
  fileURLToPath(new URL("../../src/logging/logger.ts", import.meta.url)),
  fileURLToPath(new URL("../../dist/logging/logger.js", import.meta.url)),
]);

export enum LogLevel {
  Debug = TsLogLevel.DEBUG,
  Info = TsLogLevel.INFO,
  Warn = TsLogLevel.WARN,
  Error = TsLogLevel.ERROR,
}

export type LogLevelName = Lowercase<keyof typeof LogLevel>;

export interface LoggerOptions {
  sourceRoot?: string;
  minLevel?: LogLevel | LogLevelName;
}

const severityByName: Record<LogLevelName, LogLevel> = {
  debug: LogLevel.Debug,
  info: LogLevel.Info,
  warn: LogLevel.Warn,
  error: LogLevel.Error,
};

export interface LogRecord {
  readonly level: LogLevelName;
  readonly timestamp: string;
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export abstract class Logger {
  private readonly backend: TsLogger<unknown>;
  private readonly sourceRoot: string;
  private closing?: Promise<void>;
  private failure?: Error;

  constructor({ sourceRoot = process.cwd(), minLevel = LogLevel.Info }: LoggerOptions = {}) {
    if (sourceRoot === "") throw new TypeError("sourceRoot must not be empty");
    this.sourceRoot = resolve(sourceRoot);
    this.backend = new TsLogger({ type: "hidden", minLevel: Logger.severity(minLevel), stack: { capture: "off" } });
  }

  debug(message: string): void {
    this.log("debug", message);
  }

  info(message: string): void {
    this.log("info", message);
  }

  warn(message: string): void {
    this.log("warn", message);
  }

  error(message: string): void {
    this.log("error", message);
  }

  setLogLevel(level: LogLevel | LogLevelName): void {
    this.assertOpen();
    this.backend.setMinLevel(Logger.severity(level));
  }

  close(): Promise<void> {
    return this.closing ??= Promise.resolve()
      .then(() => this.finishWrites())
      .catch(error => this.recordFailure(error))
      .then(() => { if (this.failure) throw this.failure; });
  }

  /** Delivers an entry to its destination after Logger fills in the metadata. */
  protected abstract write(record: LogRecord): void;

  protected finishWrites(): Promise<void> {
    return Promise.resolve();
  }

  protected recordFailure(error: unknown): void {
    this.failure ??= isError(error) ? error :
      new Error(typeof error === "string" ? error : "Log output failed", { cause: error });
  }

  private assertOpen(): void {
    if (this.closing) throw new Error("Logger is closed");
  }

  private static severity(level: LogLevel | LogLevelName): LogLevel {
    if (typeof level === "string" && Object.hasOwn(severityByName, level)) return severityByName[level];
    if (typeof level === "number" && Object.hasOwn(LogLevel, level)) return level;
    throw new TypeError("Unknown log level");
  }

  private log(level: LogLevelName, message: string): void {
    this.assertOpen();
    if (typeof message !== "string") throw new TypeError("Log message must be a string");
    if (!this.backend.isLevelEnabled(severityByName[level])) return;

    const timestamp = new Date().toISOString();
    const caller = this.callerLocation();
    if (!caller) return;
    try {
      this.write({ level, timestamp, ...caller, message });
    } catch (error) {
      this.recordFailure(error);
    }
  }

  private callerLocation(): Pick<LogRecord, "file" | "line"> | undefined {
    let cause: unknown;
    try {
      // getCallSites accepts 1–200 frames and does not apply Error.stackTraceLimit itself.
      const limit = Math.min(200, Math.trunc(Error.stackTraceLimit));
      const frames = limit > 0 ? util.getCallSites(limit) : [];
      for (const { scriptName, lineNumber } of frames) {
        const absolute = this.absoluteFramePath(scriptName);
        if (!absolute) break;
        if (loggerFiles.has(absolute)) continue;
        if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) break;
        const withinRoot = relative(this.sourceRoot, absolute);
        const outside = withinRoot === ".." || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot);
        const file = withinRoot && !outside ? withinRoot.split(sep).join("/") : basename(absolute);
        return { file, line: lineNumber };
      }
    } catch (error) {
      cause = error;
    }
    this.recordFailure(new Error("The calling file and line are unavailable", { cause }));
  }

  private absoluteFramePath(scriptName: string): string | undefined {
    let path = scriptName;
    if (scriptName.startsWith("file:")) {
      const url = new URL(scriptName);
      // Bun's fileURLToPath accepts malformed percent escapes.
      if (url.pathname.includes("%")) decodeURIComponent(url.pathname);
      path = fileURLToPath(url);
    }
    if (!isAbsolute(path) || path.includes("\0") || path.endsWith(sep) || path.endsWith("/")) return;
    return path;
  }
}
