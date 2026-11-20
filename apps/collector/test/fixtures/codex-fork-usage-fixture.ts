import { CodexUsageFixture } from "./codex-usage-fixture.ts";

export class CodexForkUsageFixture extends CodexUsageFixture {
  static readonly forkedAt = "2026-04-15T15:00:00.123456Z";
  static readonly child = this.header({ forked_from_id: "parent", timestamp: this.forkedAt });
  static readonly inherited = { parentSessionId: "parent", inheritedThrough: { lineNumber: 3, offset: 300 },
    baseline: { inputTokens: 180, outputTokens: 20 } };
  static readonly uncertain = { parentSessionId: "parent", firstUncertain: { lineNumber: 2, offset: 100 } };

  static rows(...records: Parameters<typeof CodexUsageFixture.entries>) {
    return this.entries(...records).map(row => ({ ...row, endOffset: row.lineNumber * 100 }));
  }
}
