import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import type { TestContext } from "node:test";
import type { CollectorStorage } from "@tracerelic/collector/storage";
import { CollectorCli } from "#src/cli";

export function captureCollectorStderr(t?: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(process, "stderr");
  assert(previous);
  const lines: string[] = [];
  const pipe = new PassThrough();
  createInterface({ input: pipe }).on("line", (line: string) => lines.push(line));
  Object.defineProperty(process, "stderr", { configurable: true, value: pipe });
  const restore = () => {
    Object.defineProperty(process, "stderr", previous);
    pipe.end();
  };
  t?.after(restore);
  return { lines, restore };
}

export async function captureCollectorCli(t: TestContext, args: string[], storage: CollectorStorage) {
  const stdout: string[] = [];
  const stderr = captureCollectorStderr();
  const out = t.mock.method(console, "log", (line: string) => { stdout.push(line); });
  try {
    return { code: await CollectorCli.run(args, storage), stdout, stderr: stderr.lines };
  } finally {
    out.mock.restore();
    stderr.restore();
  }
}
