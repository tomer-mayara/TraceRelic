import type { ClaudeTranscriptEntry } from "../history/index.ts";
import { isRecordedTimestamp } from "../recorded-timestamp.ts";
import type { ClaudeUsageReport, UsageDiagnostic, UsageDiagnosticCode } from "../storage/collector-storage.ts";
import { ClaudeUsageCounts, isObject, type ReportIssue } from "./claude-usage-counts.ts";

type Fields = Readonly<Record<string, unknown>>;
type Request = Pick<ClaudeUsageReport, "at" | "status" | "messageId" | "requestId" | "turnId">;

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assistant(record: Fields): Fields | undefined {
  const message = record.message;
  if (record.type !== "assistant" || !isObject(message) || (message.role !== undefined && message.role !== "assistant")) return;
  if (record.isMeta === true || record.isCompactSummary === true || message.model === "<synthetic>") return;
  return message;
}

export class ClaudeUsage {
  private readonly reports: ClaudeUsageReport[] = [];
  private readonly diagnostics: UsageDiagnostic[] = [];
  private hasGap = false;

  static decodeBatch(entries: readonly ClaudeTranscriptEntry[]) {
    const batch = new ClaudeUsage();
    for (const entry of entries) batch.read(entry);
    return { claudeUsageReports: batch.reports, usageDiagnostics: batch.diagnostics, hasGap: batch.hasGap };
  }

  private reportIssues(sourceOrder: number): ReportIssue {
    const codes = new Set<UsageDiagnosticCode>();
    return (code, hasGap) => {
      this.hasGap ||= hasGap;
      if (!codes.has(code)) this.diagnostics.push({ code, sourceOrder });
      codes.add(code);
    };
  }

  private read({ record, timestamp, lineNumber }: ClaudeTranscriptEntry): void {
    const message = assistant(record);
    const usage = message?.usage;
    if (!message || usage === undefined || usage === null || (isObject(usage) && !Object.keys(usage).length)) return;
    const issue = this.reportIssues(lineNumber);
    if (!text(message.id) && !text(record.requestId)) {
      issue("unidentified-claude-call", true);
      return;
    }
    if (!isObject(usage) || !isRecordedTimestamp(timestamp)) {
      issue("invalid-claude-usage", true);
      return;
    }
    const request: Request = {
      at: timestamp, status: text(message.stop_reason) ? "final" : "provisional",
      ...(text(message.id) && { messageId: message.id }), ...(text(record.requestId) && { requestId: record.requestId }),
      ...(text(record.turnId) && { turnId: record.turnId }),
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
      if (isObject(item) && item.type === "message") continue;
      if (!isObject(item) || item.type !== "advisor_message") {
        issue("unsupported-claude-iteration", true);
        continue;
      }
      const native = text(item.id) ? item.id : item.iteration_id;
      const iterationId = text(native) ? `native:${native}` : `index:${index}`;
      this.observe(item, request, item.model, issue, iterationId);
    }
  }

  private observe(usage: Fields, request: Request, model: unknown, issue: ReportIssue, iterationId?: string): void {
    const counts = ClaudeUsageCounts.read(usage, issue);
    if (!counts) return;
    this.reports.push({ ...request, ...counts, ...(text(model) && { model }), ...(iterationId && { iterationId }) });
  }
}
