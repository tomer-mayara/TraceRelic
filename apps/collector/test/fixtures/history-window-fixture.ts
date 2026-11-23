import { LocalLLMHistory } from "@tracerelic/collector/history";
import { ClaudeHistory, CodexHistory } from "@tracerelic/collector/providers";
import { ClaudeProjectFixture } from "./claude-project-fixture.ts";
import { CodexRolloutFixture } from "./codex-rollout-fixture.ts";

export class HistoryWindowFixture {
  private constructor(private readonly source: CodexRolloutFixture | ClaudeProjectFixture) {}

  static async create(provider: "Codex" | "Claude Code"): Promise<HistoryWindowFixture> {
    return new HistoryWindowFixture(provider === "Codex"
      ? await CodexRolloutFixture.create()
      : await ClaudeProjectFixture.create());
  }

  close(): Promise<void> {
    return this.source.close();
  }

  reader(root = this.source.home): LocalLLMHistory {
    return this.source instanceof CodexRolloutFixture
      ? new LocalLLMHistory([new CodexHistory(root)])
      : new LocalLLMHistory([new ClaudeHistory(root)]);
  }

  message(timestamp: string, text: string) {
    return this.source instanceof CodexRolloutFixture
      ? CodexRolloutFixture.message(timestamp, text)
      : ClaudeProjectFixture.user("session-1", timestamp, text);
  }

  write(records: readonly object[]): Promise<string> {
    return this.source instanceof CodexRolloutFixture
      ? this.source.write([CodexRolloutFixture.header("session-1"), ...records])
      : this.source.write("-work", "session-1", records);
  }
}
