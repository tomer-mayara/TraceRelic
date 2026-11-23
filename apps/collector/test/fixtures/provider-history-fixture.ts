import { GlobalConfig } from "@tracerelic/collector/config";
import { ClaudeProjectFixture } from "./claude-project-fixture.ts";
import { CodexRolloutFixture } from "./codex-rollout-fixture.ts";

/** A Codex root and a Claude Code root in separate temporary directories. */
export class ProviderHistoryFixture {
  private constructor(readonly codex: CodexRolloutFixture, readonly claude: ClaudeProjectFixture) {}

  static async create(): Promise<ProviderHistoryFixture> {
    const codex = await CodexRolloutFixture.create();
    return new ProviderHistoryFixture(codex, await ClaudeProjectFixture.create());
  }

  /** The configuration that names both roots. */
  config(): GlobalConfig {
    return new GlobalConfig(this.codex.home, this.claude.home);
  }

  async close(): Promise<void> {
    await this.codex.close();
    await this.claude.close();
  }
}
