import { basename, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger as TsLogger, LogLevel as TsLogLevel, type IStackFrame } from "tslog";

export enum LogLevel {
  Debug = TsLogLevel.DEBUG,
  Info = TsLogLevel.INFO,
  Warn = TsLogLevel.WARN,
  Error = TsLogLevel.ERROR,
}

export type LogLevelName = Lowercase<keyof typeof LogLevel>;

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
  private readonly backend = new TsLogger({ type: "hidden", minLevel: LogLevel.Info, stack: { capture: "off" } });
  private readonly sourceRoot = process.cwd();
  private closing?: Promise<void>;
  private failure?: Error;

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
    const minimum = typeof level === "string" ? severityByName[level] : level;
    this.backend.setMinLevel(minimum);
  }

  close(): Promise<void> {
    this.closing ??= this.finishWrites().then(() => {
      if (this.failure) throw this.failure;
    });
    return this.closing;
  }

  /** Delivers an entry to its destination after Logger fills in the metadata. */
  protected abstract write(record: LogRecord): void;

  protected finishWrites(): Promise<void> {
    return Promise.resolve();
  }

  protected recordFailure(error: Error): void {
    this.failure ??= error;
  }

  private assertOpen(): void {
    if (this.closing) throw new Error("Logger is closed");
  }

  private log(level: LogLevelName, message: string): void {
    this.assertOpen();
    if (!this.backend.isLevelEnabled(severityByName[level])) return;

    const timestamp = new Date().toISOString();
    const caller = this.callerLocation(new Error());
    if (caller) {
      this.write({ level, timestamp, ...caller, message });
    }
  }

  private callerLocation(position: Error): Pick<LogRecord, "file" | "line"> | undefined {
    const [ownFrame, ...frames] = this.backend.runtime.getErrorTrace(position);
    // The first frame identifies this module in both source-mapped and compiled stacks.
    const ownFile = this.absoluteFramePath(ownFrame);
    if (!ownFile) return;
    for (const frame of frames) {
      const absolute = this.absoluteFramePath(frame);
      if (absolute === ownFile) continue;
      const line = Number(frame.fileLine);
      if (!absolute || !Number.isSafeInteger(line) || line < 1) return;
      const withinRoot = relative(this.sourceRoot, absolute);
      const outside = withinRoot === ".." || withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot);
      return { file: outside ? basename(absolute) : withinRoot.split(sep).join("/"), line };
    }
  }

  private absoluteFramePath(frame?: IStackFrame): string | undefined {
    if (!frame?.fullFilePath) return;
    const location = frame.fullFilePath;
    const suffix = `:${frame.fileLine}${frame.fileColumn ? `:${frame.fileColumn}` : ""}`;
    const file = location.endsWith(suffix) ? location.slice(0, -suffix.length) : location;
    const path = file.startsWith("file:") ? fileURLToPath(file) : file;
    return isAbsolute(path) ? path : undefined;
  }
}
