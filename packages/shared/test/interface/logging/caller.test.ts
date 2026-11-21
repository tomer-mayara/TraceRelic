import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { LocalFileLogger } from "@tracerelic/shared/logging";
import { reportWarning } from "../../fixtures/caller app/jobs/internal/logger.ts";
import { CallerProbe, callerRoot } from "../../fixtures/caller-probe.ts";
import { RecordingLogger } from "../../fixtures/recording-logger.ts";

test("reports the application source and line under a root with a space", () => {
  const logger = new RecordingLogger({ sourceRoot: callerRoot });
  const { start, end } = reportWarning(logger, "History file skipped");
  assert.equal(logger.records.length, 1);
  const [entry] = logger.records;
  assert.equal(entry.file, "jobs/internal/logger.ts");
  assert.equal(entry.line, 10);
  const time = Date.parse(entry.timestamp);
  assert(start <= time && time <= end);
});

test("uses the basename for a sibling path that starts with the root name", () => {
  const logger = new RecordingLogger({ sourceRoot: join(dirname(callerRoot), "caller") });
  reportWarning(logger, "Outside the root");
  assert.equal(logger.records[0].file, "logger.ts");
});

test("the file entry uses the caller under its configured source root", async (t) => {
  const probe = await CallerProbe.create();
  t.after(() => probe.close());
  const logger = new LocalFileLogger({ filePath: probe.filePath, sourceRoot: callerRoot });
  const { start, end } = reportWarning(logger, "History file skipped");
  await logger.close();
  const entries = await probe.entries();
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.partialDeepStrictEqual(entry, { file: "jobs/internal/logger.ts", line: 10, level: "warn", message: "History file skipped" });
  assert(entry && typeof entry === "object" && "timestamp" in entry && typeof entry.timestamp === "string");
  const time = Date.parse(entry.timestamp);
  assert(start <= time && time <= end);
});

test("preserves line breaks in real source filenames", { skip: process.platform === "win32" }, async (t) => {
  const names = ["audit\rsource.mjs", "audit\nsource.mjs", "audit\r\nsource.mjs", "audit:91:3\n    at fake.mjs"];
  const probe = await CallerProbe.create();
  t.after(() => probe.close());
  const source = await CallerProbe.unmappedWarning();
  const logger = new LocalFileLogger({ filePath: probe.filePath });
  const stderr = t.mock.method(process.stderr, "write");
  for (const name of names) {
    const file = join(probe.directory, name);
    await writeFile(file, source);
    const app: typeof import("../../fixtures/caller app/jobs/internal/logger.ts") = await import(pathToFileURL(file).href);
    app.reportWarning(logger, "Read failed");
  }
  await logger.close();
  assert.equal(stderr.mock.callCount(), 0);
  const entries = await probe.entries();
  assert.equal(entries.length, names.length);
  for (const [index, file] of names.entries()) {
    assert.partialDeepStrictEqual(entries[index], { file, line: 3, level: "warn", message: "Read failed" });
  }
});
