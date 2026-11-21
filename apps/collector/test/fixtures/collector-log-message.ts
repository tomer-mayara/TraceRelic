import assert from "node:assert/strict";

/** Read the message from one CLI diagnostic captured on a pipe. */
export function collectorLogMessage(line: string, level: "WARN" | "ERROR"): string {
  const fields = /^(\S+) (WARN|ERROR) (?:[^\r\n]*?[/\\])?cli\.(?:ts|js):[1-9]\d* ([^\r\n]*)\n?$/.exec(line);
  assert(fields, `Expected one collector CLI log entry, received ${JSON.stringify(line)}`);
  const [, timestamp, actualLevel, message] = fields;
  assert.equal(timestamp, new Date(timestamp).toISOString());
  assert.equal(actualLevel, level);
  return message;
}
