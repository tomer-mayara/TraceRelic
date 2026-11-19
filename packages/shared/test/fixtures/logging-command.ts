import { execFile } from "node:child_process";

const sharedRoot = new URL("../", import.meta.resolve("@tracerelic/shared"));

export type LoggingProgram = "fixtures/console-error" | "fixtures/file-error" | "integration/logging/internal/console-logger.test";
export type StderrMode = "pipe" | "terminal" | "no-color-terminal";

export class LoggingCommand {
  static run(runtime: "bun" | "node", name: LoggingProgram, args: string[] = [], stderrMode?: StderrMode) {
    const program = runtime === "bun"
      ? [`test/${name}.ts`]
      : ["--enable-source-maps", `dist/test/${name}.js`];
    const terminal = stderrMode === "terminal" || stderrMode === "no-color-terminal";
    const executable = terminal ? "bun" : runtime;
    const command = terminal ? ["test/fixtures/terminal.ts", runtime, ...program] : program;
    const env = stderrMode ? {
      ...process.env, TERM: "xterm-256color", CI: undefined, NODE_DISABLE_COLORS: undefined,
      FORCE_COLOR: stderrMode === "pipe" ? "1" : undefined,
      NO_COLOR: stderrMode === "no-color-terminal" ? "1" : undefined,
    } : process.env;
    return new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
      execFile(executable, [...command, ...args], { cwd: sharedRoot, env, encoding: "utf8" }, (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      });
    });
  }
}
