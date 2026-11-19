import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeProjectFixture } from "./claude-project-fixture.ts";
import { CodexRolloutFixture } from "./codex-rollout-fixture.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.resolve("@tracerelic/collector/package.json")));

export class LocalCollectorCliFixture {
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

  writeChat(root: CodexRolloutFixture, id: string): Promise<string> {
    return root.write([CodexRolloutFixture.header(id), CodexRolloutFixture.message("2026-02-01T12:00:00Z", id)]);
  }

  writeClaudeChat(id: string): Promise<string> {
    const root = new ClaudeProjectFixture(join(this.configured.home, "claude"));
    return root.write("project", id, [ClaudeProjectFixture.user(id, "2026-02-01T12:00:00Z", id)]);
  }

  run(args: string[]) {
    const result = spawnSync("bun", ["run", "collector", ...args], {
      cwd: repoRoot, encoding: "utf8",
      env: { ...process.env, CODEX_HOME: this.elsewhere.home, CODEX_PATH: this.elsewhere.home },
    });
    if (result.error) throw result.error;
    return result;
  }

  history(configPath: string) {
    return this.run(["history", "--config", configPath, "--from", "2026-02-01T00:00:00Z", "--to", "2026-02-02T00:00:00Z"]);
  }
}
