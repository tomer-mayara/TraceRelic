import type { ClaudeTranscriptEntry } from "../index.ts";
import { isRecordedTimestamp } from "@tracerelic/shared";
import type { ClaudeCallOrigin, ClaudeUsageReport, UsageDiagnostic, UsageDiagnosticCode } from "../../storage/collector-storage.ts";
import type { ClaudeSubagent } from "./claude-session-identity.ts";
import { ClaudeUsageCounts, isObject, type ReportIssue } from "./claude-usage-counts.ts";

type Fields = Readonly<Record<string, unknown>>;
type Request = Pick<ClaudeUsageReport, "at" | "status" | "messageId" | "requestId" | "turnId" | "origin">;
type Entry = ClaudeTranscriptEntry & { readonly startOffset?: number };
type Fork = Pick<ClaudeCallOrigin, "parentSessionId" | "parentMessageUuid">;

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assistant(record: Fields): Fields | undefined {
  const message = record.message;
  if (record.type !== "assistant" || !isObject(message) || (message.role !== undefined && message.role !== "assistant")) return;
  if (record.isMeta === true || record.isCompactSummary === true || message.model === "<synthetic>") return;
  return message;
}

function forkOrigin(value: unknown): Fork | undefined {
  if (value === undefined || value === null) return;
  if (!isObject(value) || !text(value.sessionId)) return {};
  return { parentSessionId: value.sessionId, ...(text(value.messageUuid) && { parentMessageUuid: value.messageUuid }) };
}

function callOrigin(entry: Entry, fork: Fork | undefined, subagent?: ClaudeSubagent): ClaudeCallOrigin | undefined {
  if (entry.startOffset === undefined) return;
  const { record, lineNumber, startOffset, endOffset } = entry;
  const row = {
    sourceOrder: lineNumber, byteRange: { startOffset, endOffset }, ...(text(record.uuid) && { transcriptUuid: record.uuid }),
    ...(subagent && { parentSessionId: subagent.parentSessionId }),
  };
  if (fork) return { ...row, kind: "copy", ...fork };
  const own = !subagent || (record.isSidechain !== false
    && (text(record.agentId) ? record.agentId === subagent.agentId : record.isSidechain === true));
  return { ...row, kind: own ? "own" : "subagent" };
}

export class ClaudeUsage {
  private readonly reports: ClaudeUsageReport[] = [];
  private readonly diagnostics: UsageDiagnostic[] = [];
  private hasGap = false;

  static decodeBatch(entries: readonly Entry[], subagent?: ClaudeSubagent, previousCopy = false) {
    const batch = new ClaudeUsage();
    let parentSessionId: string | undefined;
    for (const entry of entries) {
      const fork = forkOrigin(entry.record.forkedFrom);
      const count = batch.reports.length;
      batch.read(entry, fork, subagent);
      if (!previousCopy || text(entry.record.uuid) || count !== batch.reports.length) {
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
    const origin = callOrigin(entry, fork, subagent);
    const request: Request = {
      at: timestamp, status: text(message.stop_reason) ? "final" : "provisional",
      ...(text(message.id) && { messageId: message.id }), ...(text(record.requestId) && { requestId: record.requestId }),
      ...(text(record.turnId) && { turnId: record.turnId }), ...(origin && { origin }),
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
      this.observe(item, request, item.model, issue, { iterationId, iterationPosition: index });
    }
  }

  private observe(usage: Fields, request: Request, model: unknown, issue: ReportIssue,
    iteration?: Pick<ClaudeUsageReport, "iterationId" | "iterationPosition">): void {
    const counts = ClaudeUsageCounts.read(usage, issue);
    if (!counts) return;
    this.reports.push({ ...request, ...counts, ...(text(model) && { model }), ...iteration });
  }
}
