import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ClaudeProjectFixture } from "./claude-project-fixture.ts";
import { CodexRolloutFixture } from "./codex-rollout-fixture.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.resolve("@tracerelic/collector/package.json")));

export class LocalCollectorCliFixture {
  private readonly localEnv = { ...process.env, TRACERELIC_COLLECTOR_API_URL: undefined, TRACERELIC_COLLECTOR_TOKEN: undefined };

  private constructor(readonly configured: CodexRolloutFixture, readonly elsewhere: CodexRolloutFixture) {}

  static async create(): Promise<LocalCollectorCliFixture> {
    return new LocalCollectorCliFixture(await CodexRolloutFixture.create(), await CodexRolloutFixture.create());
  }

  async close(): Promise<void> {
    await Promise.all([this.configured.close(), this.elsewhere.close()]);
  }

  async writeConfig(codexPath: string, claudePath?: string): Promise<string> {
    const directory = join(this.configured.home, "settings");
    await mkdir(directory, { recursive: true });
    const file = join(directory, "local.json");
    await writeFile(file, JSON.stringify({ codexPath, claudePath }));
    return relative(repoRoot, file);
  }

  writeChat(root: CodexRolloutFixture, id: string, at = "2026-02-01T12:00:00Z"): Promise<string> {
    return root.write([CodexRolloutFixture.header(id), CodexRolloutFixture.message(at, id)]);
  }

  writeClaudeChat(id: string, at = "2026-02-01T12:00:00Z"): Promise<string> {
    const root = new ClaudeProjectFixture(join(this.configured.home, "claude"));
    return root.write("project", id, [ClaudeProjectFixture.user(id, at, id)]);
  }

  run(args: string[]) {
    const result = spawnSync("bun", ["run", "collector", ...args], {
      cwd: repoRoot, encoding: "utf8",
      env: { ...this.localEnv, CODEX_HOME: this.elsewhere.home, CODEX_PATH: this.elsewhere.home },
    });
    if (result.error) throw result.error;
    return result;
  }

  async watchThroughSignal(config: string, signal: "SIGINT" | "SIGTERM") {
    const child = spawn("bun", ["--silent", "run", "collector", "--config", config, "watch"], {
      cwd: repoRoot, env: this.localEnv, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, killSignal: "SIGKILL",
    });
    const stdout: string[] = [];
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    createInterface({ input: child.stdout }).on("line", (line: string) => {
      stdout.push(line);
      if (stdout.length === 1) child.kill(signal);
    });
    const [code, exitSignal] = await once(child, "close");
    return { code, exitSignal, stdout, stderr };
  }

  history(configPath: string) {
    return this.run(["history", "--config", configPath, "--from", "2026-02-01T00:00:00Z", "--to", "2026-02-02T00:00:00Z"]);
  }
}
