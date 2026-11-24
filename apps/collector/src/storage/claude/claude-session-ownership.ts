import { isDeepStrictEqual } from "node:util";
import type { ClaudeIdentity, ClaudeOriginReports, LocatedOrigin, NativeCall, OwnedReport } from "./claude-origin-reports.ts";
import type { SourceUsageDiagnostic } from "../collector-storage.ts";

interface Owner extends ClaudeIdentity {
  sessionId: string;
  key: string;
}

/** Decide the owner before numeric reconciliation can group a single-ID report with a different request. */
export class ClaudeSessionOwnership {
  readonly assigned = new Map<string, Owner | null>();
  readonly diagnostics = new Map<string, SourceUsageDiagnostic>();
  readonly contributions = new Map<string, OwnedReport[]>();

  constructor(sessionId: string, records: ClaudeOriginReports, parent?: ClaudeOriginReports, known?: ClaudeSessionOwnership) {
    for (const call of records.calls.values()) this.assigned.set(call.key, this.owner(sessionId, call, parent, known));
    for (const { report, origin, callKey, lc17 } of records.rows) {
      const owner = this.assigned.get(callKey);
      if (owner) {
        const reports = this.contributions.get(owner.sessionId) ?? [];
        const located: OwnedReport = lc17 ? report : { ...report, origin };
        reports.push(owner.sessionId === sessionId ? located : ClaudeSessionOwnership.rekey(located, owner));
        this.contributions.set(owner.sessionId, reports);
      } else if (origin) this.note(origin);
    }
  }

  private static rekey(report: OwnedReport, owner: Owner): OwnedReport {
    const { requestId: _, messageId: __, ...fields } = report;
    return { ...fields, ...(owner.requestId && { requestId: owner.requestId }), ...(owner.messageId && { messageId: owner.messageId }) };
  }

  private owner(sessionId: string, call: NativeCall, parent?: ClaudeOriginReports, known?: ClaudeSessionOwnership): Owner | null {
    let match: NativeCall | undefined;
    if (parent) for (const row of call.origins.length ? call.origins : [undefined]) {
      if (row?.kind === "copy" && !row.parentSessionId) continue;
      const candidate = parent.match(call, row, call.requestOwnsIterations);
      if (candidate === null || (candidate && match && match !== candidate)) return null;
      if (candidate) match = candidate;
    }
    if (match) return known?.assigned.get(match.key) ?? null;
    if (call.origins.some(row => row.kind === "copy") || (call.origins.length && call.origins.every(row => row.kind === "subagent"))) return null;
    const { key, messageId, requestId, iterationId } = call;
    return { sessionId, key, messageId, requestId, iterationId };
  }

  private note(row: LocatedOrigin): void {
    const { streamId, installationId, sourceOrder, byteRange } = row;
    const key = JSON.stringify([streamId, installationId]);
    const earlier = this.diagnostics.get(key)?.byteRange;
    if (earlier && earlier.startOffset <= byteRange.startOffset) return;
    this.diagnostics.set(key, { code: "unresolved-claude-fork", sourceOrder, byteRange, streamId,
      ...(installationId !== undefined && { installationId }) });
  }

  recordChanges(previous: ClaudeSessionOwnership | undefined, sessionId: string, changed: Set<string>): void {
    if (isDeepStrictEqual(this.assigned, previous?.assigned) && isDeepStrictEqual(this.diagnostics, previous?.diagnostics)) return;
    changed.add(sessionId);
    for (const [id, owner] of this.assigned) {
      const oldOwner = previous?.assigned.get(id);
      if (oldOwner && owner && oldOwner.sessionId !== owner.sessionId) {
        changed.add(oldOwner.sessionId);
        changed.add(owner.sessionId);
      }
    }
  }
}
