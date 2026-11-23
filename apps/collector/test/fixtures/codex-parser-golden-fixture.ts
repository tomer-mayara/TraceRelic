import type { CodexSessionParser } from "#src/scan/codex-session-parser";
import { type GoldenBatch, GoldenTranscript } from "./parser-golden-fixture.ts";

type Fields = Readonly<Record<string, unknown>>;
type CodexEntry = Parameters<CodexSessionParser["decodeBatch"]>[0][number] & { readonly startOffset: number };
type CodexDamage = NonNullable<Parameters<CodexSessionParser["decodeBatch"]>[1]>[number];
type ForkPlan = Parameters<typeof CodexSessionParser.forFork>[0];
type CodexBatch = GoldenBatch<CodexEntry, CodexDamage>;

const repository = "https://example.org/golden/repo.git";

/** Builds Codex rollout records. Each time is a UTC time on 2026-05-04. */
export class CodexRecord {
  static line(time: string, type: string, payload: Fields): Fields {
    return { timestamp: `2026-05-04T${time}Z`, type, payload };
  }

  static header(time: string, id: string, fields: Fields = {}): Fields {
    return this.line(time, "session_meta", {
      id, timestamp: `2026-05-04T${time}Z`, cwd: "/golden/work", originator: "codex_cli_rs", cli_version: "0.50.0", source: "cli",
      git: { commit_hash: "0d1e2f3a", branch: "main", repository_url: repository }, ...fields,
    });
  }

  static turn(time: string, turnId: string, fields: Fields = {}): Fields {
    return this.line(time, "turn_context", {
      turn_id: turnId, cwd: "/golden/work/app", approval_policy: "on-request", model: "gpt-golden",
      git: { repository_url: repository, branch: "feature/golden" }, ...fields,
    });
  }

  static started(time: string, turnId: string, startedAt: number): Fields {
    return this.event(time, "task_started", { turn_id: turnId, started_at: startedAt, model_context_window: 272000 });
  }

  static completed(time: string, turnId: string, lastMessage: string): Fields {
    return this.event(time, "task_complete", { turn_id: turnId, last_agent_message: lastMessage });
  }

  static event(time: string, type: string, fields: Fields): Fields {
    return this.line(time, "event_msg", { type, ...fields });
  }

  static message(time: string, role: string, content: readonly Fields[], fields: Fields = {}): Fields {
    return this.line(time, "response_item", { type: "message", role, content, ...fields });
  }

  static input(text: string): Fields {
    return { type: "input_text", text };
  }

  static output(text: string): Fields {
    return { type: "output_text", text };
  }

  static tokens(input: number, cached: number, output: number, reasoning: number): Fields {
    return {
      input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning,
      total_tokens: input + output,
    };
  }

  static report(time: string, total: Fields | null, last: Fields | null, fields: Fields = {}): Fields {
    return this.event(time, "token_count", {
      info: { total_token_usage: total, last_token_usage: last, model_context_window: 272000 }, rate_limits: null, ...fields,
    });
  }
}

const R = CodexRecord;
const again = R.event("10:00:11.000", "user_message", { message: "Again, please.", images: [] });
const grown = R.report("10:00:20.000", R.tokens(1700, 1050, 450, 170), null);
const image = { type: "input_image", image_url: "data:image/png;base64,R09MREVO" };

/** Fixed Codex rollouts for the parser goldens. A string line is a damaged line. */
export class CodexParserGoldenFixture {
  static readonly forkedAt = "2026-05-04T11:00:00.000Z";

  static readonly batches: readonly CodexBatch[] = GoldenTranscript.batches(
    { harness: "codex", sessionId: "golden-codex", sourceFile: "/golden/codex/rollout-golden.jsonl" }, [[
      // Lines 1-13: a verified header, two turns, a first counter and its repeat. The last user event has no typed copy yet.
      R.header("10:00:00.000", "golden-codex"),
      R.turn("10:00:01.000", "turn-1"),
      R.started("10:00:01.000", "turn-1", 1777888801),
      R.message("10:00:02.000", "user", [R.input("Summarize the golden plan.")]),
      R.event("10:00:02.000", "user_message", { message: "Summarize the golden plan.", images: [] }),
      R.message("10:00:05.000", "assistant", [R.output("Plan: measure first, then refine.")], { id: "msg_golden_plan" }),
      R.event("10:00:05.000", "agent_message", { message: "Plan: measure first, then refine." }),
      R.report("10:00:06.000", R.tokens(1200, 800, 300, 120), R.tokens(1200, 800, 300, 120)),
      R.report("10:00:07.000", R.tokens(1200, 800, 300, 120), R.tokens(1200, 800, 300, 120)),
      R.completed("10:00:08.000", "turn-1", "Plan: measure first, then refine."),
      R.started("10:00:10.000", "turn-2", 1777888810),
      R.turn("10:00:10.000", "turn-2"),
      again,
    ], [
      // Lines 14-16: the same prompt again, a typed copy with an ID, and a native call without a total, which stays pending.
      again,
      R.message("10:00:11.000", "user", [R.input("Again, please.")], { id: "item_golden_again" }),
      R.report("10:00:12.000", null, R.tokens(150, 100, 40, 10), { request_id: "req_golden_a" }),
    ], [
      // Lines 17-19: a native call with a request alias closes a window that also holds the pending call.
      R.message("10:00:15.000", "assistant", [R.output("Check passed.")], { id: "msg_golden_check" }),
      R.event("10:00:15.000", "agent_message", { message: "Check passed." }),
      R.report("10:00:16.000", R.tokens(1600, 1000, 420, 160), R.tokens(150, 50, 60, 20),
        { call_id: "call_golden_b", request_id: "req_golden_b" }),
    ], [
      // Lines 20-32: growth without an ID, its exact replay, a counter reset, a native response record and a damaged line.
      grown,
      grown,
      R.completed("10:00:21.000", "turn-2", "Check passed."),
      R.turn("10:01:00.000", "turn-3"),
      R.started("10:01:00.000", "turn-3", 1777888860),
      R.event("10:01:01.000", "user_message", { message: "Compare before and after.", images: [image.image_url] }),
      R.message("10:01:01.000", "user", [R.input("Compare before "), image, R.input("and after.")]),
      R.message("10:01:04.000", "assistant", [R.output("Both match.")], { id: "msg_golden_compare" }),
      R.event("10:01:04.000", "agent_message", { message: "Both match." }),
      R.report("10:01:05.000", R.tokens(40, 0, 10, 0), R.tokens(40, 0, 10, 0), { request_id: "req_golden_c" }),
      R.line("10:01:06.000", "token_usage_record", {
        thread_id: "golden-codex", turn_id: "turn-3", response_id: "resp_golden_d",
        usage: R.tokens(30, 10, 8, 2), thread_token_usage: R.tokens(70, 10, 18, 2),
      }),
      R.completed("10:01:07.000", "turn-3", "Both match."),
      '{"timestamp":"2026-05-04T10:01:08.000Z","type":"event_msg","payload":{"type":"token_cou',
    ], [
      // Lines 33-37: a new baseline after the damage. The last assistant message has no event copy.
      R.turn("10:02:00.000", "turn-4", { request_id: "req_golden_turn4" }),
      R.started("10:02:00.000", "turn-4", 1777888920),
      R.message("10:02:01.000", "user", [R.input("Summarize the golden plan.")]),
      R.report("10:02:03.000", R.tokens(120, 20, 30, 5), R.tokens(50, 10, 12, 3), { call_id: "call_golden_e" }),
      R.message("10:02:04.000", "assistant", [R.output("Done.")], { id: "msg_golden_done" }),
    ]]);

  static readonly forkBatches: readonly CodexBatch[] = GoldenTranscript.batches(
    { harness: "codex", sessionId: "golden-codex-fork", sourceFile: "/golden/codex/rollout-golden-fork.jsonl" }, [[
      // Lines 1-3 are copies from the parent. The child turn starts after the fork time.
      R.header("11:00:00.000", "golden-codex-fork", { forked_from_id: "golden-codex" }),
      R.message("11:00:00.000", "user", [R.input("Summarize the golden plan.")]),
      R.report("11:00:00.000", R.tokens(1200, 800, 300, 120), R.tokens(1200, 800, 300, 120), { request_id: "req_golden_parent" }),
      R.turn("11:00:05.000", "fork-turn-1"),
      R.started("11:00:05.000", "fork-turn-1", 1777892405),
      R.event("11:00:06.000", "user_message", { message: "Try the other path.", images: [] }),
    ], [
      // Lines 7-11: the first child counter continues from the fork baseline.
      R.message("11:00:06.000", "user", [R.input("Try the other path.")]),
      R.message("11:00:09.000", "assistant", [R.output("Taking the other path.")], { id: "msg_golden_fork" }),
      R.event("11:00:09.000", "agent_message", { message: "Taking the other path." }),
      R.report("11:00:10.000", R.tokens(1400, 920, 350, 132), R.tokens(150, 100, 40, 10), { request_id: "req_golden_fork" }),
      R.completed("11:00:11.000", "fork-turn-1", "Taking the other path."),
    ]]);

  /** The child copied lines 1 to 3 from its parent. Its own counter continues from the parent's counter at the fork. */
  static readonly forkPlan: ForkPlan = {
    parentSessionId: "golden-codex",
    inheritedThrough: { lineNumber: 3, offset: CodexParserGoldenFixture.forkBatches[0].entries[2].endOffset },
    baseline: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800, reasoningTokens: 120 },
  };
}
