import type { Fields } from "#src/transcript/json-record";
import { ClaudeChatFixture } from "./claude-chat-fixture.ts";

export class ClaudeUsageFixture {
  static readonly at = ClaudeChatFixture.at;

  static row(usage: unknown, message: Fields = {}, record: Fields = {}): Fields {
    return {
      type: "assistant", timestamp: this.at, requestId: "req", turnId: "turn", ...record,
      message: { id: "msg", role: "assistant", model: "executor", usage, ...message },
    };
  }

  static entries(...rows: Fields[]) {
    return ClaudeChatFixture.transcript(rows).entries;
  }

  static positioned(...rows: Fields[]) {
    // Each selected row follows bytes from another session in the same physical file.
    return this.entries(...rows).map(entry => ({ ...entry, lineNumber: entry.lineNumber + 7, startOffset: entry.endOffset - 77 }));
  }

  static advisorExample() {
    // Provider example in https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool#usage-and-billing
    return {
      input_tokens: 1760, cache_read_input_tokens: 412, cache_creation_input_tokens: 0, output_tokens: 531,
      iterations: [
        { type: "message", input_tokens: 412, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 89 },
        { type: "advisor_message", model: "claude-opus-5-5", input_tokens: 823, cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0, output_tokens: 1612 },
        { type: "message", input_tokens: 1348, cache_read_input_tokens: 412, cache_creation_input_tokens: 0, output_tokens: 442 },
      ],
    };
  }
}
