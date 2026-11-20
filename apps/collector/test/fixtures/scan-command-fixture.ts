import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CollectorCommand } from "@tracerelic/collector/command";
import type { Message } from "../../src/storage/collector-storage.ts";
import { ClaudeProjectFixture } from "./claude-project-fixture.ts";
import { CodexRolloutFixture } from "./codex-rollout-fixture.ts";
import { InMemoryCollectorStorage } from "./in-memory-collector-storage.ts";

export class ScanCommandFixture {
  readonly storage = new InMemoryCollectorStorage();
  readonly codexKey = { harness: "codex", sessionId: "codex-plan" } as const;
  readonly claudeKey = { harness: "claude", sessionId: "claude-plan" } as const;
  codexMessages: Pick<Message, "at" | "role" | "text">[] = [];
  readonly claudeTexts = ["How should we evaluate search?", "Check relevance first.", "Then measure latency."];
  claudeMessages: Pick<Message, "at" | "role" | "text">[] = [];
  readonly projectPath: string;
  private readonly claude: ClaudeProjectFixture;
  readonly configFile: string;
  private command = new CollectorCommand(this.storage);
  private rollout!: string;
  private cumulative = 0;

  private constructor(private readonly codex: CodexRolloutFixture) {
    this.claude = new ClaudeProjectFixture(join(codex.home, "claude"));
    this.projectPath = join(codex.home, "work", "search");
    this.configFile = join(codex.home, "collector.json");
  }

  static async create(): Promise<ScanCommandFixture> {
    return new ScanCommandFixture(await CodexRolloutFixture.create());
  }

  async configure(): Promise<void> {
    await writeFile(this.configFile, JSON.stringify({ codexPath: this.codex.home, claudePath: this.claude.home }));
  }

  close(): Promise<void> {
    return this.codex.close();
  }

  async writePlanningChat(prompt = "Plan the search rollout", reply = "Compare the ranking methods"): Promise<void> {
    const promptAt = "2026-02-01T12:00:00.123Z";
    const replyAt = "2026-02-01T12:00:03.456Z";
    this.codexMessages = [{ at: promptAt, role: "user", text: prompt }, { at: replyAt, role: "assistant", text: reply }];
    this.rollout = await this.codex.write([
      CodexRolloutFixture.header(this.codexKey.sessionId),
      CodexRolloutFixture.turnContext("2026-02-01T12:00:00Z", "planning-turn"),
      CodexRolloutFixture.message(promptAt, prompt),
      { timestamp: replyAt, type: "response_item", payload: {
        type: "message", role: "assistant", content: [{ type: "output_text", text: reply }],
      } },
    ]);
  }

  async writeCumulativeReports(first: number, repeated: number, last: number): Promise<void> {
    await this.writePlanningChat();
    await this.appendRecords([
      this.tokenReport("2026-02-01T12:00:04Z", first, first),
      this.tokenReport("2026-02-01T12:00:05Z", repeated, first),
      this.tokenReport("2026-02-01T12:00:06Z", last, last - repeated),
    ]);
    this.cumulative = last;
  }

  async appendCodexCall(tokens: number): Promise<void> {
    this.cumulative += tokens;
    await this.appendRecords([
      CodexRolloutFixture.turnContext("2026-02-01T12:10:00Z", "follow-up-turn"),
      this.tokenReport("2026-02-01T12:10:01Z", this.cumulative, tokens),
    ]);
  }

  private appendRecords(records: object[]): Promise<void> {
    return appendFile(this.rollout, records.map(record => JSON.stringify(record) + "\n").join(""));
  }

  private tokenReport(at: string, total: number, last: number) {
    const usage = (tokens: number) => ({
      input_tokens: tokens - Math.floor(tokens / 5), cached_input_tokens: 0,
      output_tokens: Math.floor(tokens / 5), reasoning_output_tokens: 0, total_tokens: tokens,
    });
    const report = CodexRolloutFixture.tokenCount(at);
    report.payload.info.total_token_usage = usage(total);
    report.payload.info.last_token_usage = usage(last);
    return report;
  }

  async writeRepeatedClaudePrompt(prompt: string): Promise<void> {
    const sessionId = this.claudeKey.sessionId;
    const promptAt = "2026-02-01T12:02:00.123Z";
    const answerAt = "2026-02-01T12:02:01.234Z";
    const repeatAt = "2026-02-01T12:02:02.345Z";
    const first = "  Check relevance first.";
    const second = "Then measure latency.\n";
    this.claudeMessages = [
      { at: promptAt, role: "user", text: prompt },
      { at: answerAt, role: "assistant", text: first },
      { at: answerAt, role: "assistant", text: second },
      { at: repeatAt, role: "user", text: prompt },
    ];
    await this.claude.write("project", sessionId, [
      { ...ClaudeProjectFixture.user(sessionId, promptAt, prompt), cwd: this.projectPath, uuid: "prompt-first" },
      { sessionId, timestamp: answerAt, type: "assistant", uuid: "reply", message: {
        role: "assistant", content: [
          { type: "text", text: first },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "timings.md" } },
          { type: "text", text: second },
        ],
      } },
      { ...ClaudeProjectFixture.user(sessionId, repeatAt, prompt), uuid: "prompt-repeat" },
    ]);
  }

  async writeClaudeRequest(input: number, provisional: number, final: number): Promise<void> {
    const sessionId = this.claudeKey.sessionId;
    const [prompt, first, second] = this.claudeTexts;
    const report = (uuid: string, timestamp: string, text: string, output: number, stopReason: string | null) => ({
      sessionId, uuid, timestamp, type: "assistant", requestId: "request-plan",
      message: {
        id: "message-plan", role: "assistant", content: [{ type: "text", text }], stop_reason: stopReason,
        usage: { input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: output },
      },
    });
    await this.claude.write("project", sessionId, [
      { ...ClaudeProjectFixture.user(sessionId, "2026-02-01T12:01:00Z", prompt), uuid: "claude-prompt" },
      report("claude-first", "2026-02-01T12:01:01Z", first, provisional, null),
      report("claude-second", "2026-02-01T12:01:02Z", second, final, "end_turn"),
    ]);
  }

  async scan(...selection: string[]): Promise<void> {
    await this.command.run(["scan", "--once", "--config", this.configFile, ...selection]);
  }

  restart(): void {
    this.command = new CollectorCommand(this.storage);
  }
}
