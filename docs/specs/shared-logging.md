# Shared logging plan

A developer can read a warning in the terminal or in a local file and find the line that produced it. The first delivery is the shared API at `@tracerelic/shared/logging`. It lives in `packages/shared`. The collector writes its command results to standard output (stdout). Its console logs go to standard error (stderr). [Collector entry point](../../apps/collector/src/cli.ts)

## Public contract

`ConsoleLogger` and `LocalFileLogger` both extend `Logger`.

| Class | What it does |
| --- | --- |
| `Logger` | Applications call `debug(message)`, `info(message)`, `warn(message)`, or `error(message)` with one string. Each method returns `void`. The base class gets the level from the method name and records the time, calling file, and line. The destination receives the completed entry through its protected `write` method. |
| `new ConsoleLogger(options?)` | Writes `timestamp LEVEL file:line message` to stderr. The command owns stderr and can keep using it after the logger closes. |
| `new LocalFileLogger({ filePath, ...options })` | Creates or appends to a UTF-8 file. It writes one JSON object per line, in call order for that logger. |

The shared package exports the numeric enum `LogLevel`. It uses tslog’s severity values of 2 for `Debug`, 3 for `Info`, 4 for `Warn`, and 5 for `Error`. File records use the lowercase names `debug`, `info`, `warn`, and `error`. [TypeSpec contract](shared-logging/logging.tsp)

`minLevel` sets the initial severity threshold. The default is `LogLevel.Info`. The logger accepts a message when its severity is at least the current threshold. Both `logger.setLogLevel(LogLevel.Warn)` and `logger.setLogLevel("warn")` select warnings and errors on that instance. The change takes effect on the next call. Earlier accepted entries still reach the destination.

`sourceRoot` sets the directory for displayed source paths. Its default is the working directory. The constructor resolves `sourceRoot` and `filePath`. It throws `TypeError` for an empty path.

On a color-capable stderr terminal, color only the level label. Use cyan for `DEBUG`, green for `INFO`, yellow for `WARN`, and red for `ERROR`. Restore the foreground color immediately after the label. Use plain text when stderr is redirected or `NO_COLOR` has a nonempty value. File records always use the original fields.

Each entry contains `level`, `timestamp`, `file`, `line`, and `message`. Record the UTC date and time of the call with milliseconds. Line numbers start at one. Display files under `sourceRoot` as relative paths with `/` separators. Use the basename for a file outside that directory. Escape carriage returns and newlines in the console file and message fields. Parsing a file entry must restore the original strings.

```text
2026-11-19T18:23:41.072Z WARN jobs/internal/logger.ts:42 History file skipped
```

```json
{"level":"warn","timestamp":"2026-11-19T18:23:41.072Z","file":"jobs/internal/logger.ts","line":42,"message":"History file skipped"}
```

`close(): Promise<void>` stops new entries as soon as it is called. A later call to a log method or to `setLogLevel(level)` throws synchronously. Close waits for this logger's accepted writes and closes its owned file. Repeated close calls have the same result. If caller capture fails, skip that entry. If capture or output fails, reject close with the first failure after pending writes settle. Include the resolved `filePath` for a file output error. Stderr writes can be synchronous on some systems. [Node process I/O](https://nodejs.org/api/process.html#a-note-on-process-io)

## Caller location

Pin **tslog 5.5.0** in the shared package for the severity threshold and stack parsing. Set `type: "hidden"` to silence its output. Turn off automatic stack capture. After a message passes the threshold, record the UTC time and capture one stack in `Logger`. Parse it with `runtime.getErrorTrace`. The automatic lookup can skip an application file in an `internal/` directory. With a short stack, it can return a tslog line. [tslog settings](https://tslog.js.org/#settings-are-grouped) · [Stack parser](https://github.com/fullstack-build/tslog/blob/v5.5.0/src/env/providerBase.ts) · [Frame selection](https://github.com/fullstack-build/tslog/blob/v5.5.0/src/env/stackTrace.ts)

Skip the leading frames from the actual `Logger` module, using its source and build paths. The next frame must identify a local file and a positive integer line. If it does not, record a capture failure. Calculate the displayed path from the full location in the frame. Remove its line and column suffix. Convert a file URL to a filesystem path. On Node, use the original TypeScript location when source maps are available. With no map, use the executing JavaScript location. [Workspace source maps](../../.swcrc) · [Node source maps](https://nodejs.org/api/cli.html#--enable-source-maps)

For an exact line on Bun, call the logger as a statement, including inside a callback. Bun can remove the calling frame for `return logger.warn(message)`. In that form the stack can identify only the nearest caller it retained. [WebKit tail calls](https://webkit.org/blog/6240/ecmascript-6-proper-tail-calls-in-webkit/)

## Ticket appendix

Start each ticket with its tagged Given–When–Then examples. Bind the steps to the public package. Run the selected examples before changing production code. An undefined step is a test setup error. Record the first failed assertion or missing public export. For each numbered step, write a focused test and see it fail. Make the smallest change that passes it. Refactor while it is green, then rerun the test and the acceptance example. Keep already-passing examples as regression tests. [Executable feature](../../packages/shared/test/acceptance/logging/logging.feature) · [Test conventions](../engineering-guidelines/coding-principles.md)

### LOG-00a · Print an error to the console

**Acceptance.** Given a default `ConsoleLogger`, when the test calls `logger.error("message")` once, then stderr contains one `ERROR` line with the message `message`. [@log00a examples](../../packages/shared/test/acceptance/logging/logging.feature#L3)

1. **Interface.** Use a recording subclass to check that `error("message")` submits one `error` record with that message. Add the public `Logger` export and the error method after the test fails.
2. **Integration.** Construct `const logger: Logger = new ConsoleLogger()` in the fixture command. Capture stderr and make the acceptance test pass through the console formatter.

**Verified on Bun and Node.** The first acceptance run failed because the package did not export `./logging`. Both runtimes now print one error line to stderr and leave stdout empty.

### LOG-00b · Write an error to a local file

**Acceptance.** Given a `LocalFileLogger` for a new temporary file, when the test calls `logger.error("message")` once and awaits `logger.close()`, then the file contains one JSON line with `level` equal to `error` and `message` equal to `message`. Both command streams are empty. [@log00b examples](../../packages/shared/test/acceptance/logging/logging.feature#L9)

1. **Unit.** Use a writable fixture to check that the file logger writes one JSON record followed by a newline. Reuse the record from `Logger`.
2. **Interface.** Construct `const logger: Logger = new LocalFileLogger({ filePath })` with the temporary path. Use one append stream and attach its error handler before writing. Read the file after close.

**Verified on Bun and Node.** The first file acceptance run failed because the package did not export `LocalFileLogger`. After close, each file contains one record that passes the schema check. Both command streams stay empty.

### LOG-01 · Locate a console warning

**Acceptance.** Given a command that prints `[]`, when `jobs/internal/logger.ts:42` issues a warning, then stderr shows that line and stdout contains only the command result. Run the source fixture with Bun and the compiled fixture with Node. [@log01 examples](../../packages/shared/test/acceptance/logging/logging.feature#L24)

1. **Interface.** Check the exact caller through the recording subclass from LOG-00a. Make the compiled call land on a different line from the TypeScript call. Check the source line with maps and the generated line without maps.
2. **Unit.** Check a file URL with a space, a file under the root, and one in a sibling such as `app-old`. Normalize the path once when building each record. Measure the start and end of the call in the fixture process. Check that the timestamp falls in that interval.
3. **Integration.** Capture both command streams. Compare the full stderr line to the documented format and stdout to the command result.

### LOG-02 · Append a file entry and finish pending writes

**Acceptance.** Given a file containing `Earlier`, when a new logger writes `First` and `Second` and closes, then all three entries can be read in order. Also check the caller on both runtimes. Use the file logger from LOG-00b. [@log02 examples](../../packages/shared/test/acceptance/logging/logging.feature#L30)

1. **Interface.** Extend the temporary-file test to check all five fields against the expected caller and message.
2. **Integration.** Reopen the file. Change the fixture's working directory after construction. Check both paths and the exact message order. Cover empty path options in a unit test.
3. **Unit.** Hold the last write until the fixture clock moves past the call time. Check that the entry keeps its original timestamp. Make close wait for the write to finish and the file to close.

### LOG-03 · Set and change the minimum log level

**Acceptance.** Given a `Logger` at `info`, when the caller raises its level to `error` and then lowers it to `debug`, each change applies to the next call. Both destinations must retain the earlier accepted entry and emit the newly enabled debug entry. [@log03 examples](../../packages/shared/test/acceptance/logging/logging.feature#L71)

1. **Interface.** Call `setLogLevel(level)` through a `Logger` reference for each concrete class. Check the default, the constructor setting, and both level changes. Keep a second instance at `info` to verify that changing the first instance affects only that logger.
2. **Unit.** Hold an accepted write pending, raise the threshold, and check that the write still completes. Implement `setLogLevel` once in `Logger` by calling `setMinLevel` on its existing tslog instance. [tslog level setter](https://github.com/fullstack-build/tslog/blob/v5.5.0/src/BaseLogger.ts#L264)
3. **Unit.** Give a suppressed call an unavailable caller. Close must succeed with zero writes. Return on tslog’s level decision before capturing a stack.

**Verified on Bun and Node.** The first message test failed on the missing `debug` method. The numeric enum test first returned `"debug"` where it expected `2`. The destination tests check the exact levels, UTC time, and application line for both forms of the warning threshold. [Destination examples](../../packages/shared/test/acceptance/logging/logging.feature#L55)

### LOG-04 · Keep one physical line per entry

**Acceptance.** Given a message with quotes, a backslash, and a line break, when it is logged, then each destination has one line. The JSON message decodes to the original text. [@log04 examples](../../packages/shared/test/acceptance/logging/logging.feature#L86)

1. **Unit.** Test CR, LF, and CRLF in console text, including the displayed filename. Escape these characters in the console formatter.
2. **Interface.** Read and parse the file line. Serialize the original record once with the JSON encoder.

### LOG-05 · Handle a missing caller

**Acceptance.** Given one accepted entry, when the next call has an empty stack or only logger frames, then close reports the missing caller and the file contains the accepted entry. [@log05 examples](../../packages/shared/test/acceptance/logging/logging.feature#L102)

1. **Unit.** Check an empty stack, an internal-only stack, and a frame with a missing file or invalid line. Write zero entries for each failed capture.
2. **Integration.** Limit the stack for one call in an isolated process. Restore the limit and close the logger. Finish the accepted write before reporting the failure.

### LOG-06 · Close the logger and report output errors

**Acceptance.** Given a directory used as a file or a closed stderr pipe, when the caller logs a warning, then close reports the output error. A command can still use healthy stderr after closing its console logger. [@log06 examples](../../packages/shared/test/acceptance/logging/logging.feature#L115)

1. **Interface.** Open a directory as the file destination. Assert the rejection includes its path. In a child process, send stderr to a pipe with a closed reader. Check that `close()` rejects on both runtimes and the process can report the failure.
2. **Unit.** Fail a queued write or file close. Call `close()` twice while a write is pending. Both callers must get the same outcome. Check that logging or calling `setLogLevel(LogLevel.Debug)` during or after close throws synchronously.
3. **Integration.** Close a console logger, then write `Done` from the same command. Wait for the logger's own writes and leave the shared stream open.

### LOG-07 · Color the console level labels

**Acceptance.** Given a color-capable stderr terminal and a minimum level of `debug`, when the caller logs at each level, then each label uses its assigned color. The timestamp, source location, and message stay plain. [@log07 examples](../../packages/shared/test/acceptance/logging/logging.feature#L134)

1. **Unit.** Assert the exact foreground color for each uppercase label and the reset immediately after it. Keep the palette in the console formatter. The file formatter receives the original record.
2. **Interface.** Exercise stderr on a terminal, through a pipe, and on a terminal with `NO_COLOR=1`. Check the captured text in each case. Use the built-in `styleText` with stderr when styling is enabled. [Node text styles](https://nodejs.org/api/util.html#utilstyletextformat-text-options)

**Verified on Bun and Node.** The terminal test first received plain `DEBUG` where it expected cyan. It now checks the foreground color and reset for all four labels. The pipe and `NO_COLOR=1` tests check the plain output.

To see the four log lines that the console unit test checks, run this command in a terminal from the repository root.

```sh
bun run --cwd packages/shared compile && bun test ./packages/shared/test/unit/logging/console-logger.test.ts
```

## Constraints and verification

| Constraint | Check |
| --- | --- |
| Behavior | Call `@tracerelic/shared/logging` from the tests. Use a child process to check real command output on Bun and Node. Run the TypeScript source on Bun and the SWC build on Node with `--enable-source-maps`. Use a separate build without maps for the fallback case. [Feature](../../packages/shared/test/acceptance/logging/logging.feature) |
| Observability | Check the caller, level labels in colored and plain output, clean stdout, and errors returned by close. These are local outputs. This component has no service-level objective. |
| Architecture | Applications may use the shared package. The logger cannot depend on an application. Only its base class imports tslog in production code. Run dependency-cruiser with the logging rules. [Rules](shared-logging/dependencies.json) · [Component manifest](../../packages/shared/component.yaml) |
| Interface | Compile TypeSpec and emit JSON Schema. Validate real file entries against `LogRecord` in the feature steps. Type-check both subclasses and `setLogLevel(level)` through `Logger`. [Contract](shared-logging/logging.tsp) |

Run `bun run check:shared-logging` to build the fixtures, emit the schema, check dependencies, and run the delivered Cucumber scenarios. The file scenario validates each record against the schema. CI also runs `bun run test` and `bun run lint`. [Workspace scripts](../../package.json) · [CI workflow](../../.github/workflows/collector.yml)
