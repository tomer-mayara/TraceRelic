import type { DamagedLine } from "../history/index.ts";
import type { TokenCounts, Usage, UsageAnchor, UsageDiagnostic, UsageWindow } from "../storage/collector-storage.ts";
import { invalidState, jsonDigest, stateRecord, stateString } from "./chat-parser-state.ts";
import { type Breakdown, breakdowns, difference, mergeRepeated, object, partition, restoredCounts, sameTotals, zero } from "./codex-usage-counts.ts";
import { advanceContext, type Call, type CallContext, initialHistory, readReport, recorded, type Report, type UsageEntry } from "./codex-usage-report.ts";

type Result = { usage: Usage[]; usageWindows: UsageWindow[]; usageAnchors?: UsageAnchor[]; usageDiagnostics?: UsageDiagnostic[]; hasGap: boolean };
type SeenCall = Pick<TokenCounts, "inputTokens" | "outputTokens"> & { historyId: string };

function validHistory(value: unknown): value is string {
  return typeof value === "string" && /^(?:un)?verified:[a-f0-9]{64}(?::reset:[a-f0-9]{64})?$/.test(value);
}

function validCallId(value: unknown): value is string {
  return typeof value === "string" && /^call:native:[a-f0-9]{64}$/.test(value);
}

function couldBeSameCall(pending: Call, last: Call): boolean {
  return sameTotals(pending, last)
    && (!pending.turnId || !last.turnId || pending.turnId === last.turnId)
    && (!pending.model || !last.model || pending.model === last.model);
}

function restoreCall(value: unknown): Call {
  const fields = stateRecord(value, ["id", "kind", "revision", "at", "turnId", "requestId", "model",
    "inputTokens", "outputTokens", ...breakdowns]);
  const { id, kind, revision, at, turnId, requestId, model, ...amount } = fields;
  if (!validCallId(id) || kind !== "call" || revision !== 1 || !recorded(at)) invalidState();
  const call: Call = { id, kind, revision, at, ...restoredCounts(amount) };
  for (const [key, value] of [["turnId", turnId], ["requestId", requestId], ["model", model]] as const) {
    const text = stateString(value);
    if (text) call[key] = text;
  }
  return call;
}

function diagnose(result: Result, code: "unsupported-codex-usage" | "codex-counter-reset", sourceOrder: number): void {
  result.hasGap = true;
  (result.usageDiagnostics ??= []).push({ code, sourceOrder });
}

export class CodexUsage {
  private historyId = "";
  private baseline?: TokenCounts;
  private needsBaseline = false;
  private context: CallContext = {};
  private readonly disputed = new Set<Breakdown>();
  private readonly observations = new Set<string>();
  private lastObservation?: string;
  // Keep native IDs after closing their window. A reset can replay the very same provider request.
  private readonly seen = new Map<string, SeenCall>();
  private readonly pending = new Map<string, Call>();

  static resume(state?: unknown): CodexUsage {
    const usage = new CodexUsage();
    if (state === undefined) return usage;
    const saved = stateRecord(state, ["historyId", "baseline", "turnId", "model", "requestId", "seen", "pending",
      "disputed", "observations", "awaitingBaseline"]);
    if (saved.awaitingBaseline !== undefined && saved.awaitingBaseline !== true) invalidState();
    usage.needsBaseline = saved.awaitingBaseline === true;
    if (saved.historyId !== undefined && !validHistory(saved.historyId)) invalidState();
    usage.historyId = saved.historyId ?? "";
    usage.restoreObservations(saved.observations);
    if (usage.observations.size > 0 && !usage.historyId) invalidState();
    if (saved.baseline !== undefined) {
      if (!usage.historyId) invalidState();
      usage.baseline = restoredCounts(saved.baseline);
    }
    if (Boolean(usage.baseline) !== (usage.observations.size > 0)) invalidState();
    usage.context = { turnId: stateString(saved.turnId), model: stateString(saved.model), requestId: stateString(saved.requestId) };
    if (!usage.historyId && Object.values(usage.context).some(Boolean)) invalidState();
    if (!Array.isArray(saved.disputed)) invalidState();
    for (const value of saved.disputed) {
      const key = breakdowns.find(k => k === value);
      if (!key || !usage.baseline || usage.baseline[key] !== undefined || usage.disputed.has(key)) invalidState();
      usage.disputed.add(key);
    }
    usage.restoreCalls(saved.seen, saved.pending);
    if (usage.needsBaseline && usage.pending.size) invalidState();
    return usage;
  }

  private restoreObservations(value: unknown): void {
    if (!Array.isArray(value)) invalidState();
    for (const id of value) {
      if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id) || this.observations.has(id)) invalidState();
      this.observations.add(id);
      this.lastObservation = id;
    }
  }

  private restoreCalls(known: unknown, pending: unknown): void {
    for (const [id, value] of Object.entries(stateRecord(known))) {
      const { historyId, ...amount } = stateRecord(value, ["historyId", "inputTokens", "outputTokens"]);
      if (!validCallId(id) || !validHistory(historyId) || historyId.split(":reset:")[0] !== this.historyId.split(":reset:")[0]) invalidState();
      this.seen.set(id, { historyId, ...restoredCounts(amount) });
    }
    if (!Array.isArray(pending)) invalidState();
    for (const item of pending) {
      const call = restoreCall(item);
      const seen = this.seen.get(call.id);
      if (!seen || seen.historyId !== this.historyId || !sameTotals(call, seen) || this.pending.has(call.id)) invalidState();
      this.pending.set(call.id, call);
    }
  }

  snapshot(): object {
    return {
      historyId: this.historyId || undefined, baseline: this.baseline && { ...this.baseline }, ...this.context,
      ...(this.needsBaseline && { awaitingBaseline: true }),
      disputed: [...this.disputed], observations: [...this.observations],
      seen: Object.fromEntries(Array.from(this.seen, ([id, call]) => [id, { ...call }])),
      pending: Array.from(this.pending.values(), call => ({ ...call })),
    };
  }

  get awaitingBaseline(): boolean {
    return this.needsBaseline;
  }

  decodeBatch(entries: readonly UsageEntry[], damagedLines: readonly DamagedLine[] = []): Result {
    const result: Result = { usage: [], usageWindows: [], hasGap: false };
    let index = 0;
    for (const line of damagedLines) {
      while (index < entries.length && entries[index].lineNumber < line.lineNumber) this.read(entries[index++], result);
      this.interrupt();
      this.context = {};
      result.hasGap = true;
    }
    while (index < entries.length) this.read(entries[index++], result);
    return result;
  }

  private interrupt(): void {
    this.needsBaseline = true;
    // These native calls have already been published. They cannot partition a change across the gap.
    this.pending.clear();
  }

  private read(entry: UsageEntry, result: Result): void {
    const payload = object(entry.record.payload);
    if (!this.historyId) this.historyId = initialHistory(entry, payload);
    if (!payload) return;
    const event = entry.record.type === "event_msg";
    if (entry.record.type === "turn_context" || (event && payload.type === "task_started")) {
      this.context = advanceContext(entry, payload, this.context);
      return;
    }
    if (!event) return;
    if (payload.type === "task_complete" || payload.type === "turn_aborted") {
      this.context = {};
      return;
    }
    if (payload.type !== "token_count") return;
    const report = readReport(entry, payload, this.context, this.historyId);
    if (report === undefined) return;
    if (!report || report.invalidTotal) {
      diagnose(result, "unsupported-codex-usage", entry.lineNumber);
      this.interrupt();
      if (report?.independent && report.last) this.standalone(report.last, result);
      return;
    }
    if (report.end) {
      // An exact earlier observation is a replay even when its counters now look like a reset.
      const observation = jsonDigest([entry.record, report.at, report.independent && report.last?.id]);
      if (this.observations.has(observation)) return;
      this.observations.add(observation);
      this.reconcile(report.end, report, observation, result);
      this.lastObservation = observation;
      return;
    }
    if (this.historyId.startsWith("unverified:") && !this.baseline) result.hasGap = true;
    if (report.independent && report.last) this.standalone(report.last, result);
    else diagnose(result, "unsupported-codex-usage", entry.lineNumber);
  }

  private reconcile(end: TokenCounts, report: Report, observation: string, result: Result): void {
    const independent = report.independent ? report.last : undefined;
    const start = this.baseline ?? zero;
    const change = difference(end, start);
    if (!change) {
      diagnose(result, "codex-counter-reset", report.sourceOrder);
      const reset = jsonDigest([this.historyId, observation]);
      this.historyId = `${this.historyId.split(":reset:")[0]}:reset:${reset}`;
      this.baseline = undefined;
      this.rebase(end, independent, result);
      return;
    }
    if (this.needsBaseline || (!this.baseline && this.historyId.startsWith("unverified:"))) {
      this.rebase(end, independent, result);
      return;
    }
    if (this.baseline && sameTotals(this.baseline, end)) {
      mergeRepeated(this.baseline, end, this.disputed);
      if (independent && sameTotals(independent, zero)) this.zeroCall(this.baseline, independent, result);
      return;
    }
    const window: UsageWindow = { historyId: this.historyId, start: { ...start }, end: { ...end }, parts: [] };
    if (this.lastObservation) window.boundaryObservations = { start: this.lastObservation, end: observation };
    this.closeWindow(window, end, change, report, result);
  }

  private closeWindow(window: UsageWindow, end: TokenCounts, change: TokenCounts, report: Report, result: Result): void {
    const last = report.last;
    const independent = report.independent ? last : undefined;
    const seen = last && this.seen.get(last.id);
    if (seen && last && (!sameTotals(seen, last) || seen.historyId !== this.historyId)) {
      this.rebase(end, undefined, result);
      return;
    }
    const calls = [...this.pending.values()];
    // A repeated anonymous last report can describe a pending native request. Its amount alone cannot identify a second call.
    if (last && !seen && (independent || !calls.some(call => couldBeSameCall(call, last)))) calls.push(last);
    const split = partition(change, calls);
    if (!split) {
      this.rebase(end, independent, result);
      return;
    }
    const { remaining, disputed } = split;
    for (const key of breakdowns) {
      if (change[key] === undefined || disputed.includes(key)) {
        delete window.start[key];
        delete window.end[key];
      }
    }
    // An independently stored pending call keeps the exact measurement published under that ID.
    if (last && !seen) for (const key of disputed) delete last[key];
    window.parts = this.parts(window, calls, remaining, report.at);
    result.usageWindows.push(window);
    if (independent && !seen) this.remember(independent);
    this.advance(end);
  }

  private zeroCall(at: TokenCounts, call: Call, result: Result): void {
    const seen = this.seen.get(call.id);
    if (seen && !this.pending.has(call.id)) return;
    const original = this.pending.get(call.id) ?? call;
    if (!sameTotals(original, zero)) return;
    result.usageWindows.push({ historyId: this.historyId, start: { ...at }, end: { ...at }, parts: [original] });
    this.remember(original);
    this.pending.delete(call.id);
  }

  private parts(window: UsageWindow, calls: Call[], remaining: TokenCounts, at: string): Usage[] {
    const { start, end } = window;
    const parts: Usage[] = [...calls];
    if (remaining.inputTokens || remaining.outputTokens || !parts.length) {
      const id = jsonDigest([this.historyId, start.inputTokens, start.outputTokens, end.inputTokens, end.outputTokens,
        calls.map(call => call.id).sort()]);
      parts.push({ kind: "interval", id: `interval:${id}`, revision: 1, at, ...remaining });
    }
    return parts;
  }

  private remember(call: Call): void {
    this.seen.set(call.id, { historyId: this.historyId, inputTokens: call.inputTokens, outputTokens: call.outputTokens });
  }

  private standalone(call: Call, result: Result): void {
    const seen = this.seen.get(call.id);
    if (seen) {
      if (!sameTotals(seen, call)) result.hasGap = true;
      return;
    }
    this.remember(call);
    if (!this.needsBaseline) this.pending.set(call.id, { ...call });
    result.usage.push(call);
    const fresh = this.historyId.startsWith("verified:") && !this.historyId.includes(":reset:");
    const after = this.needsBaseline ? undefined : this.baseline ?? (fresh ? { inputTokens: 0, outputTokens: 0 } : undefined);
    (result.usageAnchors ??= []).push({ usageId: call.id, historyId: this.historyId, ...(after && { after: { ...after } }) });
  }

  /** Keep the identifiable calls and advance past a change whose full extent is unknown. */
  private rebase(end: TokenCounts, last: Call | undefined, result: Result): void {
    result.hasGap = true;
    if (last) this.standalone(last, result);
    this.advance(end);
  }

  private advance(end: TokenCounts): void {
    this.baseline = end;
    this.needsBaseline = false;
    this.pending.clear();
    this.disputed.clear();
  }
}
