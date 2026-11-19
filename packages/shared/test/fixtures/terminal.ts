import { spawn } from "bun";
import assert from "node:assert/strict";

const [runtime, ...args] = process.argv.slice(2);
const preload = runtime === "bun"
  ? ["--preload", "./test/fixtures/terminal-output.ts"]
  : ["--import", "./dist/test/fixtures/terminal-output.js"];
const drained = Promise.withResolvers<number>();
const child = spawn([runtime, ...preload, ...args], {
  serialization: "json",
  ipc(message: unknown) {
    assert(Array.isArray(message));
    const [channel, text]: unknown[] = message;
    assert((channel === "stdout" || channel === "stderr") && typeof text === "string");
    process[channel].write(text);
  },
  terminal: {
    exit(_terminal, status) { drained.resolve(status); },
  },
});
const [childStatus, terminalStatus] = await Promise.all([child.exited, drained.promise]);
child.terminal?.close();
process.exitCode = childStatus || terminalStatus;
