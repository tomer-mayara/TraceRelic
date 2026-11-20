import { CodexChatFixture } from "./codex-chat-fixture.ts";

export class CodexUsageFixture extends CodexChatFixture {
  static header(fields: Record<string, unknown> = {}) {
    return this.record("session_meta", { id: "planning", timestamp: this.at, ...fields });
  }

  static counts(input: number, output: number, breakdown: Record<string, unknown> = {}) {
    return { input_tokens: input, output_tokens: output, total_tokens: input + output, ...breakdown };
  }

  static report(total?: unknown, last?: unknown, fields: Record<string, unknown> = {}) {
    return this.record("event_msg", {
      type: "token_count", info: { total_token_usage: total, last_token_usage: last }, ...fields,
    });
  }
}
