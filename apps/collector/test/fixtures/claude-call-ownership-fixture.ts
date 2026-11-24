import assert from "node:assert/strict";
import type { Batch, ClaudeCallOrigin, ClaudeUsageReport, Usage } from "@tracerelic/collector/storage";
import { ClaudeCallOwners } from "#src/storage/claude/claude-call-owners";

export class ClaudeCallOwnershipFixture {
  owners = new ClaudeCallOwners();
  private readonly usage = new Map<string, Usage[]>();

  static row(kind: ClaudeCallOrigin["kind"], messageId: string | undefined, requestId: string | undefined,
    fields: Partial<ClaudeCallOrigin> = {}, iterationId?: string): ClaudeUsageReport {
    return { ...(messageId && { messageId }), ...(requestId && { requestId }), ...(iterationId && { iterationId }),
      at: "2026-02-01T12:00:00Z", status: "final", inputTokens: 80, outputTokens: 20,
      origin: { kind, sourceOrder: 1, byteRange: { startOffset: 0, endOffset: 20 }, ...fields } };
  }

  static measurement(sessionId: string, report: ClaudeUsageReport): Usage {
    const { origin: _, ...fields } = report;
    return { ...fields, kind: "call", revision: 1, id: "claude:" + JSON.stringify([sessionId, report.messageId, report.requestId, report.iterationId]) };
  }

  static batch(sessionId: string, reports: ClaudeUsageReport[], installationId = "local"): Batch {
    return { source: { harness: "claude", sessionId, streamId: sessionId + ".jsonl", installationId },
      expectedVersion: 0, expectedOffset: 0, checkpoint: { offset: 100, parserState: "" },
      usage: [], messages: [], claudeUsageReports: reports };
  }

  submit(sessionId: string, reports: ClaudeUsageReport[], parent?: string, installation?: string, raw?: Usage[]) {
    const records = new Map(this.usage.get(sessionId)?.map(row => [row.id, row]));
    for (const report of reports) {
      const next = ClaudeCallOwnershipFixture.measurement(sessionId, report);
      records.set(next.id, next);
    }
    const usage = raw ?? [...records.values()];
    const update = this.owners.prepare(ClaudeCallOwnershipFixture.batch(sessionId, reports, installation), usage, parent);
    assert(update);
    this.owners = update.owners;
    this.usage.set(sessionId, usage);
    return update.changedSessions;
  }

  view(sessionId: string) {
    return this.owners.view(sessionId, this.usage.get(sessionId) ?? []);
  }
}
