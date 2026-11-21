import "@typespec/json-schema";
using TypeSpec.JsonSchema;

@jsonSchema
namespace TraceRelic.Logging;

enum LogLevel {
  Debug: 2,
  Info: 3,
  Warn: 4,
  Error: 5,
}

union LogLevelName { "debug", "info", "warn", "error" }

/** Options for ConsoleLogger. Resolve relative paths at construction.
 * An empty path option throws TypeError. */
model LoggerOptions {
  /** Initial minimum severity. An unsupported rank or name throws TypeError. */
  minLevel?: LogLevel | LogLevelName = LogLevel.Info;
  /** Use the current working directory when this option is absent. */
  @minLength(1) sourceRoot?: string;
}

/** Options for LocalFileLogger. */
model LocalFileLoggerOptions extends LoggerOptions {
  /** Path of the file to create or append to. */
  @minLength(1) filePath: string;
}

/** Output entry. The application supplies the message to the chosen log method. */
model LogRecord {
  level: LogLevelName;
  /** UTC time of the call, with milliseconds. */
  @format("date-time")
  @pattern("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$")
  timestamp: string;
  /** Source file relative to sourceRoot, or its basename outside that directory. */
  @minLength(1) file: string;
  /** One-based line in that file. */
  @minValue(1) line: safeint;
  message: string;
}

@error
model LoggingFailure {
  message: string;
  /** Resolved destination path for a file I/O error. */
  filePath?: string;
}

/** Log methods and setLogLevel return void. An invalid message or severity throws TypeError.
 * Calling these methods after close starts throws synchronously.
 * Close reports capture and destination failures, including failures to open the file. */
interface Logger {
  /** Set this instance's minimum severity for subsequent calls.
   * A rejected value leaves the current threshold in effect.
   * Accepted records keep their place in the output. */
  setLogLevel(level: LogLevel | LogLevelName): void | LoggingFailure;
  debug(message: string): void | LoggingFailure;
  info(message: string): void | LoggingFailure;
  warn(message: string): void | LoggingFailure;
  error(message: string): void | LoggingFailure;
  /** In TypeScript this returns Promise<void>. Wait for accepted writes and
   * close the owned file. Leave stderr open. Reject with the first failure.
   * Repeated calls have the same outcome. */
  close(): void | LoggingFailure;
}
