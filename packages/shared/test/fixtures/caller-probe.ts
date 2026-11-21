import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ConsoleLogger, LocalFileLogger } from "@tracerelic/shared/logging";
import type { CallTimes } from "./caller app/jobs/internal/logger.ts";
import { LoggingCommand } from "./logging-command.ts";

const exec = promisify(execFile);
const shared = fileURLToPath(new URL("../", import.meta.resolve("@tracerelic/shared")));
export const callerRoot = join(shared, "test", "fixtures", "caller app");
const generatedWarning = join(shared, "dist/test/fixtures/caller app/jobs/internal/logger.js");

export class CallerProbe {
  runtime: "bun" | "node" = LoggingCommand.runtime;
  destination: "console" | "file" = "console";
  commandResult?: string;
  private unmappedFile?: string;
  stdout = "";
  stderr = "";

  private constructor(readonly directory: string) {}

  static async create() {
    const directory = await mkdtemp(join(tmpdir(), "tracerelic caller-"));
    return new CallerProbe(await realpath(directory));
  }

  close() {
    return rm(this.directory, { recursive: true, force: true });
  }

  static async unmappedWarning() {
    const generated = await readFile(generatedWarning, "utf8");
    return generated.replace(/^\/\/# sourceMappingURL=.*$/m, "");
  }

  async useUnmappedBuild() {
    this.runtime = "node";
    await mkdir(join(this.directory, "dist"));
    this.unmappedFile = join(this.directory, "dist/scan.js");
    await writeFile(this.unmappedFile, await CallerProbe.unmappedWarning());
  }

  async report(message: string) {
    const bun = this.runtime === "bun";
    const script = join(shared, bun ? "test/fixtures/caller-probe.ts" : "dist/test/fixtures/caller-probe.js");
    const caller = this.unmappedFile ?? (bun ? join(callerRoot, "jobs/internal/logger.ts") : generatedWarning);
    const sourceRoot = this.unmappedFile ? "." : relative(this.directory, callerRoot);
    const args = [script, this.destination, sourceRoot, pathToFileURL(caller).href, message];
    if (!bun) args.unshift(this.unmappedFile ? "--no-enable-source-maps" : "--enable-source-maps");
    if (this.commandResult !== undefined) args.push(this.commandResult);
    const result = await exec(this.runtime, args, { cwd: this.directory, timeout: 5_000 });
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }

  async times(): Promise<CallTimes> {
    const value: unknown = JSON.parse(await readFile(join(this.directory, "call-times.json"), "utf8"));
    assert(value && typeof value === "object" && "start" in value && typeof value.start === "number");
    assert("end" in value && typeof value.end === "number");
    return { start: value.start, end: value.end };
  }

  get filePath() {
    return join(this.directory, "events.jsonl");
  }

  async entries(): Promise<unknown[]> {
    const lines = (await readFile(this.filePath, "utf8")).split("\n");
    assert.equal(lines.pop(), "");
    return lines.map(line => JSON.parse(line));
  }
}

if (import.meta.main) {
  const [destination, sourceRoot, caller, message, commandResult] = process.argv.slice(2);
  const clockFile = resolve("call-times.json");
  const logger = destination === "file"
    ? new LocalFileLogger({ filePath: "events.jsonl", sourceRoot })
    : new ConsoleLogger({ sourceRoot });
  const app: typeof import("./caller app/jobs/internal/logger.ts") = await import(caller);
  if (destination === "file") {
    await mkdir("elsewhere");
    process.chdir("elsewhere");
  }
  const times = app.reportWarning(logger, message);
  await logger.close();
  await writeFile(clockFile, JSON.stringify(times));
  if (commandResult !== undefined) process.stdout.write(`${commandResult}\n`);
}
