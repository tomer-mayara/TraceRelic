import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import util from "node:util";
import { CallerStack, type CallerFrame } from "../../fixtures/caller-stack.ts";
import { RecordingLogger } from "../../fixtures/recording-logger.ts";

const logging = import.meta.resolve("@tracerelic/shared/logging");
const own = { scriptName: new URL("../../dist/logging/logger.js", logging).href, lineNumber: 8 };
const ownSource = { scriptName: new URL("../../src/logging/logger.ts", logging).href, lineNumber: 7 };
const caller = { scriptName: new URL("./jobs/internal/logger.ts", import.meta.url).href, lineNumber: 42 };
const outer = { scriptName: new URL("./outer.ts", import.meta.url).href, lineNumber: 91 };
const badUrl = { scriptName: new URL("./%XX.ts", import.meta.url).href, lineNumber: 42 };
const unavailable = /calling file and line are unavailable/i;

const missing: Record<string, CallerFrame[]> = {
  "empty stack": [],
  "only the base logger's source and build frames": [own, ownSource],
  "missing caller path": [own, { ...caller, scriptName: "" }, outer],
  "line zero": [own, { ...caller, lineNumber: 0 }, outer],
  "negative line": [own, { ...caller, lineNumber: -1 }, outer],
  "fractional line": [own, { ...caller, lineNumber: 1.5 }, outer],
  "unsafe line number": [own, { ...caller, lineNumber: Number.MAX_SAFE_INTEGER + 1 }, outer],
  "unavailable line number": [own, { ...caller, lineNumber: NaN }, outer],
  "unusable file URL": [own, badUrl, outer],
  "file URL for a directory": [own, { ...caller, scriptName: new URL("./", import.meta.url).href }, outer],
  "path with a null byte": [own, { ...caller, scriptName: new URL("./%00.ts", import.meta.url).href }, outer],
};
for (const [reason, frames] of Object.entries(missing)) {
  test(`close reports a missing caller for ${reason}`, async () => {
    const logger = new RecordingLogger();
    CallerStack.during(frames, () => logger.warn("Missing"));
    assert.deepEqual(logger.records, []);
    await assert.rejects(logger.close(), unavailable);
  });
}

test("uses the first application frame when the runtime omits the base logger frames", async () => {
  const logger = new RecordingLogger();
  CallerStack.during([caller, outer], () => logger.warn("First"));
  await logger.close();
  assert.equal(logger.records.length, 1);
  assert.match(logger.records[0].file, /jobs\/internal\/logger\.ts$/);
  assert.equal(logger.records[0].line, 42);
});

test("a caller equal to sourceRoot has a nonempty filename", async () => {
  const logger = new RecordingLogger({ sourceRoot: fileURLToPath(caller.scriptName) });
  CallerStack.during([caller], () => logger.warn("Equal"));
  await logger.close();
  assert.equal(logger.records[0].file, "logger.ts");
});

test("decodes an escaped percent in a filename and ignores percent signs in the URL query", async () => {
  const root = new URL("./", import.meta.url);
  const logger = new RecordingLogger({ sourceRoot: fileURLToPath(root) });
  const scriptName = new URL("%25XX.ts?query=%XX", root).href;
  CallerStack.during([{ ...caller, scriptName }], () => logger.warn("Literal percent"));
  await logger.close();
  assert.equal(logger.records[0].file, "%XX.ts");
});

test("a capture failure skips only the entry with the missing caller", async () => {
  const logger = new RecordingLogger();
  CallerStack.during([], () => logger.warn("Missing caller"));
  CallerStack.during([caller], () => logger.warn("Next entry"));
  await assert.rejects(logger.close(), unavailable);
  assert.deepEqual(logger.records.map(record => record.message), ["Next entry"]);
});

test("a capture exception reaches close with its cause", async (t) => {
  const logger = new RecordingLogger();
  const cause = new Error("Stack capture failed");
  t.mock.method(util, "getCallSites", () => { throw cause; });
  logger.warn("Missing");
  assert.deepEqual(logger.records, []);
  await assert.rejects(logger.close(), (error: unknown) => error instanceof Error && error.cause === cause);
});

test("close keeps the first capture error after another capture fails", async () => {
  const logger = new RecordingLogger();
  CallerStack.during([own, badUrl], () => logger.warn("Bad URL"));
  CallerStack.during([], () => logger.warn("Empty"));
  await assert.rejects(logger.close(), (error: unknown) => {
    return error instanceof Error && unavailable.test(error.message) && error.cause instanceof URIError;
  });
  assert.deepEqual(logger.records, []);
});
