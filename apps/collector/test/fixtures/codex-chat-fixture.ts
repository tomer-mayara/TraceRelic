type CodexRecord = {
  timestamp?: string;
  type: string;
  payload: unknown;
  id?: string;
};

export class CodexChatFixture {
  static readonly at = "2026-04-15T09:00:00.123456-06:00";
  static readonly later = "2026-04-15T15:00:02Z";

  static entries(...records: CodexRecord[]) {
    return records.map((record, index) => ({
      harness: "codex" as const,
      sessionId: "planning",
      sourceFile: "/fixture/sessions/rollout-planning.jsonl",
      lineNumber: index + 1,
      timestamp: record.timestamp,
      record,
    }));
  }

  static async *batches(...groups: ReturnType<typeof CodexChatFixture.entries>[]) {
    for (const entries of groups) {
      const lineNumber = entries.at(-1)?.lineNumber ?? 0;
      yield { entries, next: { lineNumber, offset: lineNumber * 100 } };
    }
  }

  static record(type: string, payload: unknown, timestamp = this.at): CodexRecord {
    return { type, payload, timestamp };
  }

  static response(role: string, content: unknown[], fields: Record<string, unknown> = {}): CodexRecord {
    return this.record("response_item", { type: "message", role, content, ...fields });
  }

  static event(type: "user_message" | "agent_message", message: string, fields: Record<string, unknown> = {}): CodexRecord {
    return this.record("event_msg", { type, message, ...fields });
  }

  static input(text: string) { return { type: "input_text", text }; }
  static output(text: string) { return { type: "output_text", text }; }
}
