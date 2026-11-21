import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.resolve("@tracerelic/api/package.json")));
const args = ["apps/api/dist/main.js"];

function options(file?: string, port = "0", databaseUrl?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: port };
  if (file) env.TRACERELIC_COLLECTOR_CREDENTIALS_FILE = file;
  else delete env.TRACERELIC_COLLECTOR_CREDENTIALS_FILE;
  if (databaseUrl !== undefined) env.DATABASE_URL = databaseUrl;
  else delete env.DATABASE_URL;
  return { cwd: root, env, timeout: 30_000, killSignal: "SIGKILL" as const };
}

export class CollectorApiProcess {
  private readonly child;
  private readonly lines;
  readonly exit;
  stderr = "";

  constructor(file: string, databaseUrl: string) {
    this.child = spawn("node", args, { ...options(file, "0", databaseUrl), stdio: ["ignore", "pipe", "pipe"] });
    this.lines = createInterface({ input: this.child.stdout })[Symbol.asyncIterator]();
    this.child.stderr.setEncoding("utf8").on("data", (line: string) => { this.stderr += line; });
    this.exit = once(this.child, "close");
  }

  static runToExit(file?: string, port?: string, databaseUrl?: string) {
    return spawnSync("node", args, { ...options(file, port, databaseUrl), timeout: 5000, encoding: "utf8" });
  }

  async nextEvent() {
    const line = await this.lines.next();
    if (line.done) throw new Error("The collector API exited before emitting an event. " + this.stderr);
    return JSON.parse(line.value);
  }

  async stop(signal: "SIGINT" | "SIGTERM") {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill(signal);
    return this.exit;
  }
}
