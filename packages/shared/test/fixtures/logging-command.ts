import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const sharedRoot = new URL("../", import.meta.resolve("@tracerelic/shared"));

type LoggingProgram = `fixtures/${string}` | `integration/${string}`;
export type StderrMode = "pipe" | "closed-pipe" | "terminal" | "no-color-terminal";

export class LoggingCommand {
  static readonly runtime = process.versions.bun ? "bun" : "node";

  static run(name: LoggingProgram, args: string[] = [], stderrMode?: StderrMode) {
    const runtime = this.runtime;
    const program = runtime === "bun"
      ? [`test/${name}.ts`]
      : ["--enable-source-maps", `dist/test/${name}.js`];
    const terminal = stderrMode === "terminal" || stderrMode === "no-color-terminal";
    const executable = terminal ? "bun" : process.execPath;
    const command = terminal ? ["test/fixtures/terminal.ts", runtime, ...program] : program;
    const env = stderrMode ? {
      ...process.env, TERM: "xterm-256color", CI: undefined, NODE_DISABLE_COLORS: undefined,
      FORCE_COLOR: stderrMode === "pipe" ? "1" : undefined,
      NO_COLOR: stderrMode === "no-color-terminal" ? "1" : undefined,
    } : process.env;
    const result = runFile(executable, [...command, ...args], {
      cwd: sharedRoot, env, encoding: "utf8", timeout: 5_000,
    });
    if (stderrMode === "closed-pipe") {
      const { stdin, stderr } = result.child;
      stderr!.once("close", () => stdin!.end());
      stderr!.destroy();
    }
    return result;
  }
}
