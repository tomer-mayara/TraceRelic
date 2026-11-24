import type { CodexRolloutSource } from "@tracerelic/collector/providers";
import { CodexUsageFixture as Usage } from "./codex-usage-fixture.ts";

type Row = ReturnType<typeof Usage.record> | null;

export class ForkEvidenceSource implements CodexRolloutSource {
  readonly fileSize: number;
  readonly sourceFile: string;
  reads = 0;
  rowsRead = 0;

  static readonly before = "2026-06-01T10:00:00Z";
  static readonly fork = "2026-06-01T11:00:00.000001Z";
  static readonly after = "2026-06-01T11:00:02Z";

  constructor(readonly sessionId: string, readonly rows: readonly Row[], readonly codexForkHeader?: {
    parentSessionId: string; forkedAt?: string;
  }) {
    this.fileSize = this.rows.length * 100;
    this.sourceFile = "/fixture/rollout-" + sessionId + ".jsonl";
  }

  static header(id: string, at = this.before, fields: Record<string, unknown> = {}) {
    return Usage.record("session_meta", { id, timestamp: at, ...fields }, at);
  }

  static total(input: number, timestamp = this.before, requestId?: string, includeLast = true) {
    return { ...Usage.report(Usage.counts(input, 0), requestId && includeLast ? Usage.counts(5, 0) : undefined,
      requestId ? { request_id: requestId } : {}), timestamp };
  }

  static child(rows: Row[], parentSessionId = "parent", sessionId = "child") {
    return new ForkEvidenceSource(sessionId, [this.header(sessionId, this.fork, { forked_from_id: parentSessionId }), ...rows],
      { parentSessionId, forkedAt: this.fork });
  }

  static liveTurn() {
    return Usage.record("event_msg", { type: "task_started", turn_id: "live", started_at: Date.parse(this.after) / 1000 }, this.after);
  }

  static childCall(id: string) {
    return { ...Usage.report(undefined, Usage.counts(5, 0), { request_id: id }), timestamp: this.after };
  }

  async *readBatches() {
    this.reads++;
    for (const [i, record] of this.rows.entries()) {
      this.rowsRead++;
      const lineNumber = i + 1;
      const startOffset = i * 100;
      const endOffset = startOffset + 100;
      const location = { lineNumber, startOffset, endOffset };
      yield {
        entries: record ? [{ harness: "codex" as const, sessionId: this.sessionId, sourceFile: this.sourceFile,
          ...location, record, timestamp: record.timestamp }] : [],
        damagedLines: record ? [] : [location], next: { offset: endOffset, lineNumber }, prefixDigest: "a".repeat(64),
      };
    }
  }

  async completeEnd() { return this.fileSize; }

  async prefixDigests(offsets: readonly number[]) {
    return offsets.map(offset => ({ offset, prefixDigest: "a".repeat(64) }));
  }
}
