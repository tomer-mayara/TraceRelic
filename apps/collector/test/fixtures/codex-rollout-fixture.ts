import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export class CodexRolloutFixture {
  private constructor(readonly home: string) {}

  static async create(): Promise<CodexRolloutFixture> {
    return new CodexRolloutFixture(await mkdtemp(join(tmpdir(), "tracerelic-codex-")));
  }

  close(): Promise<void> {
    return rm(this.home, { recursive: true, force: true });
  }

  static header(id: string) {
    return { timestamp: "2026-01-31T23:00:00Z", type: "session_meta", payload: { id } };
  }

  static message(timestamp: string, text: string) {
    return { timestamp, type: "response_item", payload: {
      type: "message", role: "user", content: [{ type: "input_text", text }],
    } };
  }

  static turnContext(timestamp: string, turnId: string) {
    return { timestamp, type: "turn_context", payload: { turn_id: turnId } };
  }

  static tokenCount(timestamp: string) {
    return {
      timestamp, type: "event_msg",
      payload: { type: "token_count", info: {
        total_token_usage: { input_tokens: 24, cached_input_tokens: 8, output_tokens: 4, reasoning_output_tokens: 2, total_tokens: 28 },
        last_token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 13 },
        model_context_window: 10000,
      }, rate_limits: null },
    };
  }

  async write(records: readonly object[], archived = false): Promise<string> {
    const folder = archived ? "archived_sessions" : join("sessions", "2026", "01", "31");
    const file = join(this.home, folder, "rollout-2026-01-31-test.jsonl");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    return file;
  }
}
