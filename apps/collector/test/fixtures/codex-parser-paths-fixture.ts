import type { CodexSessionParser } from "#src/providers/codex/codex-session-parser";
import type { Fields } from "#src/transcript/json-record";
import { CodexRecord as R } from "./codex-parser-golden-fixture.ts";
import { type GoldenLine, GoldenTranscript } from "./parser-golden-fixture.ts";

/** A batch as the history reader yields it, with its `next` position and prefix digest. */
type ReaderBatch = Parameters<CodexSessionParser["prepareLookahead"]>[1] extends AsyncIterable<infer Batch> ? Batch : never;

const image = { type: "input_image", image_url: "data:image/png;base64,R09MREVO" };

/** Fixed Codex rollouts for paths outside the main goldens. A string line is a damaged line. */
export class CodexParserPathsFixture {
  private static rollout(sessionId: string, groups: readonly (readonly GoldenLine[])[]): readonly ReaderBatch[] {
    return GoldenTranscript.batches({ harness: "codex", sessionId, sourceFile: `/golden/codex/${sessionId}.jsonl` }, groups);
  }

  /** A completed item in the paginated rollout. */
  private static completed(time: string, item: Fields): Fields {
    return R.event(time, "item_completed", { thread_id: "golden-codex-paginated", turn_id: "turn-1", item });
  }

  /** A repeated counter snapshot adds a cache read count that the baseline did not have. */
  static readonly addedBreakdown = this.rollout("golden-codex-breakdown", [[
    R.header("13:00:00.000", "golden-codex-breakdown"),
    R.turn("13:00:01.000", "turn-1"),
    R.report("13:00:02.000", { input_tokens: 20, output_tokens: 8, reasoning_output_tokens: 2, total_tokens: 28 }, null),
    R.report("13:00:03.000", R.tokens(20, 15, 8, 2), null),
  ], [
    R.report("13:00:04.000", R.tokens(25, 17, 12, 3), null),
  ]]);

  /** A two-part assistant answer leaves a joined mirror. Its per-part events arrive after the checkpoint. */
  static readonly joinedMirror = this.rollout("golden-codex-joined", [[
    R.header("13:10:00.000", "golden-codex-joined"),
    R.turn("13:10:01.000", "turn-1", { request_id: "req_golden_joined" }),
    R.started("13:10:01.000", "turn-1", 1777900201),
    R.message("13:10:03.000", "assistant", [R.output("First part. "), R.output("Second part.")], { id: "msg_golden_joined" }),
  ], [
    R.event("13:10:03.000", "agent_message", { message: "First part. " }),
    R.event("13:10:03.000", "agent_message", { message: "Second part." }),
  ]]);

  /** The header gives a branch without a remote. A later turn adds the remote, so the context keeps that order. */
  static readonly contextOrder = this.rollout("golden-codex-context", [[
    R.header("13:20:00.000", "golden-codex-context", { cwd: "/golden/local", git: { commit_hash: "0d1e2f3a", branch: "main" } }),
    R.turn("13:20:01.000", "turn-1", { cwd: "/golden/local", git: { repository_url: "https://example.org/golden/local.git" } }),
    R.event("13:20:02.000", "user_message", { message: "Is the remote set?", images: [] }),
  ], [
    R.message("13:20:04.000", "assistant", [R.output("Yes, the remote is set.")], { id: "msg_golden_remote" }),
  ]]);

  /** In paginated mode only completed items are messages. Other message records are ignored. */
  static readonly paginated = this.rollout("golden-codex-paginated", [[
    R.header("14:00:00.000", "golden-codex-paginated", { history_mode: "paginated" }),
    R.turn("14:00:01.000", "turn-1"),
    R.started("14:00:01.000", "turn-1", 1777903201),
    R.message("14:00:02.000", "user", [R.input("Show me the plan.")]),
    R.event("14:00:02.000", "user_message", { message: "Show me the plan.", images: [] }),
    this.completed("14:00:02.000", { type: "UserMessage", content: [
      { type: "text", text: "Show me " }, { type: "image", url: image.image_url }, { type: "text", text: "the plan." }] }),
    this.completed("14:00:03.000", { type: "CommandExecution", id: "item_golden_command", command: "ls" }),
    R.message("14:00:05.000", "assistant", [R.output("Plan: one step.")]),
    this.completed("14:00:05.000", { type: "AgentMessage", id: "item_golden_plan", content: [{ type: "Text", text: "Plan: one step." }] }),
    R.report("14:00:06.000", R.tokens(900, 600, 120, 40), R.tokens(900, 600, 120, 40)),
  ], [
    this.completed("14:00:10.000", { type: "AgentMessage", id: "item_golden_hidden", content: [{ type: "Text", text: "Hidden answer." }],
      moderation: { moderated: true, display: { version: 1, mode: "hide", replacement: { kind: "wellbeingPromptHelpline" } } } }),
    this.completed("14:00:11.000", { type: "AgentMessage", content: [{ type: "Text", text: "Shown after review." }], moderation: {
      moderated: true, display: { version: 1, mode: "show", trustedContacts: "check", annotation: { kind: "wellbeingHelpline", subject: "answer" } },
    } }),
    this.completed("14:00:12.000", { type: "UserMessage", id: "item_golden_thanks", content: [{ type: "text", text: "Thanks." }] }),
    R.completed("14:00:13.000", "turn-1", "Shown after review."),
  ]]);

  /** Later batches supply the layout and IDs of messages that the first batch records. */
  static readonly lookahead = this.rollout("golden-codex-lookahead", [[
    R.header("15:00:00.000", "golden-codex-lookahead"),
    R.event("15:00:01.000", "user_message", { message: "Compare before and after.", images: [image.image_url] }),
  ], [
    R.report("15:00:02.000", R.tokens(300, 200, 40, 10), R.tokens(300, 200, 40, 10)),
    R.message("15:00:03.000", "user", [R.input("Compare before "), image, R.input("and after.")],
      { id: "item_golden_typed", turn_id: "turn-golden-late", request_id: "req_golden_late" }),
    R.message("15:00:04.000", "assistant", [R.output("One"), { type: "refusal", refusal: "Not this part." }, R.output("Two")]),
  ], [
    R.event("15:00:04.000", "agent_message", { message: "Two", message_id: "msg_golden_two", request_id: "req_golden_two" }),
    R.event("15:00:04.000", "agent_message", { message: "One", message_id: "msg_golden_one" }),
  ]]);

  /** The batches after the first, as the reader yields them for a lookahead. */
  static async *lookaheadTail(): AsyncGenerator<ReaderBatch> {
    yield* CodexParserPathsFixture.lookahead.slice(1);
  }
}
