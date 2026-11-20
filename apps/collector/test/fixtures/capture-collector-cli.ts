import type { TestContext } from "node:test";
import { runCollectorCli } from "#src/cli";
import type { CollectorStorage } from "../../src/storage/collector-storage.ts";

export async function captureCollectorCli(t: TestContext, args: string[], storage: CollectorStorage) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = t.mock.method(console, "log", (line: string) => { stdout.push(line); });
  const err = t.mock.method(console, "error", (line: string) => { stderr.push(line); });
  try {
    return { code: await runCollectorCli(args, storage), stdout, stderr };
  } finally {
    out.mock.restore();
    err.mock.restore();
  }
}
