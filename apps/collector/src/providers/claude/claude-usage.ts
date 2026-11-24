import type { ClaudeTranscriptEntry } from "./claude-history.ts";
import { JsonRecord } from "../../transcript/json-record.ts";
import { isRecordedTimestamp } from "@tracerelic/shared";
import type { ClaudeCallOrigin, ClaudeUsageReport, UsageDiagnostic, UsageDiagnosticCode } from "../../storage/collector-storage.ts";
import { ClaudeAssistantRecord } from "./claude-assistant-record.ts";
import type { ClaudeSubagent } from "./claude-session-identity.ts";
import { ClaudeUsageCounts, type ReportIssue } from "./claude-usage-counts.ts";

type Fields = Readonly<Record<string, unknown>>;
type Request = Pick<ClaudeUsageReport, "at" | "status" | "messageId" | "requestId" | "turnId" | "origin">;
type Entry = ClaudeTranscriptEntry & { readonly startOffset?: number };
type Fork = Pick<ClaudeCallOrigin, "parentSessionId" | "parentMessageUuid">;

export class ClaudeUsage {
  private readonly reports: ClaudeUsageReport[] = [];
  private readonly diagnostics: UsageDiagnostic[] = [];
  private hasGap = false;

  private static text(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
  }

  private static forkOrigin(value: unknown): Fork | undefined {
    if (value === undefined || value === null) return;
    if (!JsonRecord.is(value) || !ClaudeUsage.text(value.sessionId)) return {};
    return { parentSessionId: value.sessionId, ...(ClaudeUsage.text(value.messageUuid) && { parentMessageUuid: value.messageUuid }) };
  }

  private static callOrigin(entry: Entry, fork: Fork | undefined, subagent?: ClaudeSubagent): ClaudeCallOrigin | undefined {
    if (entry.startOffset === undefined) return;
    const { record, lineNumber, startOffset, endOffset } = entry;
    const row = {
      sourceOrder: lineNumber, byteRange: { startOffset, endOffset }, ...(ClaudeUsage.text(record.uuid) && { transcriptUuid: record.uuid }),
      ...(subagent && { parentSessionId: subagent.parentSessionId }),
    };
    if (fork) return { ...row, kind: "copy", ...fork };
    const own = !subagent || (record.isSidechain !== false
      && (ClaudeUsage.text(record.agentId) ? record.agentId === subagent.agentId : record.isSidechain === true));
    return { ...row, kind: own ? "own" : "subagent" };
  }

  static decodeBatch(entries: readonly Entry[], subagent?: ClaudeSubagent, previousCopy = false) {
    const batch = new ClaudeUsage();
    let parentSessionId: string | undefined;
    for (const entry of entries) {
      const fork = ClaudeUsage.forkOrigin(entry.record.forkedFrom);
      const count = batch.reports.length;
      batch.read(entry, fork, subagent);
      if (!previousCopy || ClaudeUsage.text(entry.record.uuid) || count !== batch.reports.length) {
        parentSessionId ??= subagent?.parentSessionId ?? fork?.parentSessionId;
      }
    }
    return { claudeUsageReports: batch.reports, usageDiagnostics: batch.diagnostics, hasGap: batch.hasGap,
      ...(parentSessionId && { metadata: { parentSessionId } }) };
  }

  private reportIssues(sourceOrder: number): ReportIssue {
    const codes = new Set<UsageDiagnosticCode>();
    return (code, hasGap) => {
      this.hasGap ||= hasGap;
      if (!codes.has(code)) this.diagnostics.push({ code, sourceOrder });
      codes.add(code);
    };
  }

  private read(entry: Entry, fork: Fork | undefined, subagent?: ClaudeSubagent): void {
    const { record, timestamp, lineNumber } = entry;
    const message = ClaudeAssistantRecord.message(record);
    const usage = message?.usage;
    if (!message || usage === undefined || usage === null || (JsonRecord.is(usage) && !Object.keys(usage).length)) return;
    const issue = this.reportIssues(lineNumber);
    if (!ClaudeUsage.text(message.id) && !ClaudeUsage.text(record.requestId)) {
      issue("unidentified-claude-call", true);
      return;
    }
    if (!JsonRecord.is(usage) || !isRecordedTimestamp(timestamp)) {
      issue("invalid-claude-usage", true);
      return;
    }
    const origin = ClaudeUsage.callOrigin(entry, fork, subagent);
    const request: Request = {
      at: timestamp, status: ClaudeUsage.text(message.stop_reason) ? "final" : "provisional",
      ...(ClaudeUsage.text(message.id) && { messageId: message.id }), ...(ClaudeUsage.text(record.requestId) && { requestId: record.requestId }),
      ...(ClaudeUsage.text(record.turnId) && { turnId: record.turnId }), ...(origin && { origin }),
    };
    this.observe(usage, request, message.model, issue);
    this.readIterations(usage.iterations, request, issue);
  }

  private readIterations(iterations: unknown, request: Request, issue: ReportIssue): void {
    if (iterations === undefined || iterations === null) return;
    if (!Array.isArray(iterations)) {
      issue("unsupported-claude-iteration", true);
      return;
    }
    for (const [index, item] of iterations.entries()) {
      // The top-level usage already includes all executor iterations.
      if (JsonRecord.is(item) && item.type === "message") continue;
      if (!JsonRecord.is(item) || item.type !== "advisor_message") {
        issue("unsupported-claude-iteration", true);
        continue;
      }
      const native = ClaudeUsage.text(item.id) ? item.id : item.iteration_id;
      const iterationId = ClaudeUsage.text(native) ? `native:${native}` : `index:${index}`;
      this.observe(item, request, item.model, issue, { iterationId, iterationPosition: index });
    }
  }

  private observe(usage: Fields, request: Request, model: unknown, issue: ReportIssue,
    iteration?: Pick<ClaudeUsageReport, "iterationId" | "iterationPosition">): void {
    const counts = ClaudeUsageCounts.read(usage, issue);
    if (!counts) return;
    this.reports.push({ ...request, ...counts, ...(ClaudeUsage.text(model) && { model }), ...iteration });
  }
}
