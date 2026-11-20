import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export class ClaudeProjectFixture {
  constructor(readonly home: string) {}

  static async create(): Promise<ClaudeProjectFixture> {
    return new ClaudeProjectFixture(await mkdtemp(join(tmpdir(), "tracerelic-claude-")));
  }

  close(): Promise<void> {
    return rm(this.home, { recursive: true, force: true });
  }

  static user(sessionId: string, timestamp: string, text: string) {
    return { sessionId, timestamp, type: "user", message: { role: "user", content: text } };
  }

  static assistant(sessionId: string, timestamp: string, text: string) {
    return {
      sessionId, timestamp, type: "assistant", requestId: "request-1",
      message: {
        id: "message-1", role: "assistant",
        content: [
          { type: "text", text },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "plan.md" } },
        ],
        usage: { input_tokens: 40, cache_read_input_tokens: 8, cache_creation_input_tokens: 3, output_tokens: 21 },
      },
    };
  }

  async write(project: string, transcript: string, records: readonly object[]): Promise<string> {
    const file = join(this.home, "projects", project, transcript + ".jsonl");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, records.map(record => JSON.stringify(record) + "\n").join(""));
    return file;
  }
}
