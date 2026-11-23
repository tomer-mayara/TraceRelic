import type { ClaudeSessionParser } from "#src/scan/claude-session-parser";
import { type GoldenBatch, type GoldenDamage, type GoldenLine, GoldenTranscript } from "./parser-golden-fixture.ts";

type Fields = Readonly<Record<string, unknown>>;
type ClaudeEntry = Parameters<ClaudeSessionParser["decodeBatch"]>[0][number] & { readonly startOffset: number };
type Subagent = NonNullable<Parameters<typeof ClaudeSessionParser.forSource>[1]>;
type ClaudeBatch = GoldenBatch<ClaudeEntry, GoldenDamage>;

// The executor iterations add up to the top-level usage. The advisor iteration is charged separately.
const finalUsage = {
  input_tokens: 16, cache_creation_input_tokens: 300, cache_read_input_tokens: 2400,
  cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 }, output_tokens: 85, service_tier: "standard",
  iterations: [
    { type: "message", input_tokens: 10, cache_read_input_tokens: 1200, cache_creation_input_tokens: 300, output_tokens: 40 },
    { type: "advisor_message", model: "claude-golden-advisor", input_tokens: 900, cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0, output_tokens: 140 },
    { type: "message", input_tokens: 6, cache_read_input_tokens: 1200, cache_creation_input_tokens: 0, output_tokens: 45 },
  ],
};
const provisionalUsage = {
  input_tokens: 4, cache_creation_input_tokens: 40, cache_read_input_tokens: 2700,
  cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 0 }, output_tokens: 1, service_tier: "standard",
};

/** Builds Claude Code transcript rows for one source. Each time is a UTC time on 2026-05-04. */
class ClaudeRows {
  constructor(private readonly source: Fields) {}

  user(time: string, content: unknown, fields: Fields = {}): Fields {
    return this.row(time, "user", { role: "user", content }, fields);
  }

  assistant(time: string, message: Fields, fields: Fields = {}): Fields {
    return this.row(time, "assistant", { type: "message", role: "assistant", model: "claude-golden-5", stop_sequence: null, ...message }, fields);
  }

  static text(text: string): Fields {
    return { type: "text", text };
  }

  lines(): GoldenLine[][] {
    const text = ClaudeRows.text;
    const again = this.user("12:00:09.000", "Again?");
    const copied = (messageUuid: string) => ({ forkedFrom: { sessionId: "golden-claude-origin", messageUuid }, gitBranch: "feature/golden" });
    return [[
      // Lines 1-6: prompts with and without a UUID, injected reminders, a final and a provisional report, and a repeated prompt.
      this.user("12:00:00.000", "Find the golden fixtures.", { uuid: "uuid-golden-01" }),
      this.user("12:00:01.000", "<system-reminder>Use the golden fixtures.</system-reminder>", { uuid: "uuid-golden-02" }),
      this.user("12:00:02.000", [text("List them by size."), text("<system-reminder>Sizes are in bytes.</system-reminder>"),
        text("Largest first.")], { repository: "https://example.org/golden/repo.git" }),
      this.assistant("12:00:05.000", { id: "msg_golden_1", content: [text("Found three fixtures.")], stop_reason: "end_turn", usage: finalUsage },
        { uuid: "uuid-golden-04", requestId: "req_golden_1", turnId: "turn-golden-1" }),
      this.assistant("12:00:07.000", { id: "msg_golden_2", content: [text("Sorting by size.")], stop_reason: null, usage: provisionalUsage },
        { uuid: "uuid-golden-05", requestId: "req_golden_2", turnId: "turn-golden-1" }),
      again,
    ], [
      // Lines 7-10: the repeated prompt again, rows copied from another session, and a report from another agent.
      again,
      this.user("12:00:10.000", [text("Copied question.")], { uuid: "uuid-golden-08", ...copied("uuid-origin-08") }),
      this.assistant("12:00:12.000", { id: "msg_golden_3", content: "Copied answer.", stop_reason: "end_turn",
        usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } },
        { uuid: "uuid-golden-09", requestId: "req_golden_3", ...copied("uuid-origin-09") }),
      this.assistant("12:00:14.000", { id: "msg_golden_4", content: [text("Other agent note.")], stop_reason: "end_turn",
        usage: { input_tokens: 7, output_tokens: 3 } }, { uuid: "uuid-golden-10", requestId: "req_golden_4", agentId: "golden-other-agent" }),
    ]];
  }

  private row(time: string, type: string, message: Fields, fields: Fields): Fields {
    return {
      parentUuid: null, ...this.source, userType: "external", cwd: "/golden/work", version: "2.1.0", gitBranch: "main",
      type, message, timestamp: `2026-05-04T${time}Z`, ...fields,
    };
  }
}

/** Fixed Claude transcripts for the parser goldens: a subagent file and an earlier copy of a main session file. */
export class ClaudeParserGoldenFixture {
  static readonly subagent: Subagent = { parentSessionId: "golden-claude-parent", agentId: "golden-agent" };

  static readonly subagentBatches: readonly ClaudeBatch[] = GoldenTranscript.batches({
    harness: "claude", sessionId: "golden-claude-parent/subagents/golden-agent",
    sourceFile: "/golden/claude/projects/-golden-work/golden-claude-parent/subagents/agent-golden-agent.jsonl",
  }, new ClaudeRows({ isSidechain: true, sessionId: "golden-claude-parent", agentId: "golden-agent" }).lines());

  static readonly earlierCopyBatches: readonly ClaudeBatch[] = GoldenTranscript.batches({
    harness: "claude", sessionId: "golden-claude",
    sourceFile: "/golden/claude/projects/-golden-work/golden-claude.jsonl.superseded-20260504T120100Z",
  }, new ClaudeRows({ isSidechain: false, sessionId: "golden-claude" }).lines());
}
