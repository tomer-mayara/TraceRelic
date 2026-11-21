import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { CallerStack } from "../../fixtures/caller-stack.ts";
import { CapturedLogger } from "../../fixtures/captured-logger.ts";

test("console entries escape CR, LF and CRLF in the file and message", async (t) => {
  const capture = await CapturedLogger.open("the console");
  t.after(() => capture.dispose());
  const file = pathToFileURL(resolve("src/a\rb\nc\r\nd.ts"));
  CallerStack.during([{ scriptName: file.href, lineNumber: 42 }], () => {
    capture.logger.warn('one\r"two"\nthree\\four\r\nfive');
  });

  const text = await capture.text();
  const [timestamp] = text.split(" ");
  assert.equal(text, `${timestamp} WARN src/a\\rb\\nc\\r\\nd.ts:42 one\\r"two"\\nthree\\four\\r\\nfive\n`);
});
