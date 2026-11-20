import type { DamagedLine } from "../history/index.ts";
import type { TokenCounts, Usage, UsageDiagnostic, UsageWindow } from "../storage/collector-storage.ts";
import { invalidState, jsonDigest, stateRecord, stateString } from "./chat-parser-state.ts";
import type { CodexForkUsage } from "./codex-fork-usage.ts";
import { type Breakdown, breakdowns, difference, mergeRepeated, object, partition, restoredCounts, sameTotals, zero } from "./codex-usage-counts.ts";
import { type Call, type CallContext, type Fields, initialHistory, readReport, recorded,
  type Report, reportContext, type UsageEntry } from "./codex-usage-report.ts";
import type { DecodedUsage } from "./decoded-chat.ts";

type Result = DecodedUsage;
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
  const fields = stateRecord(value, ["id", "kind", "revision", "at", "turnId", "requestId", "responseId", "model",
    "inputTokens", "outputTokens", ...breakdowns]);
  const { id, kind, revision, at, turnId, requestId, responseId, model, ...amount } = fields;
  if (!validCallId(id) || kind !== "call" || revision !== 1 || !recorded(at)) invalidState();
  const call: Call = { id, kind, revision, at, ...restoredCounts(amount) };
  for (const [key, value] of [["turnId", turnId], ["requestId", requestId], ["responseId", responseId], ["model", model]] as const) {
    const text = stateString(value);
    if (text) call[key] = text;
  }
  return call;
}

/** Keep fresh pending calls byte-identical to the same calls restored from the checkpoint. */
function savedCall({ id, turnId, requestId, responseId, model, ...fields }: Call): Call {
  return { id, ...fields, ...(turnId && { turnId }), ...(requestId && { requestId }),
    ...(responseId && { responseId }), ...(model && { model }) };
}

function diagnose(result: Result, code: UsageDiagnostic["code"], sourceOrder: number): void {
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
  private readonly aliases = new Map<string, Set<string>>();
  private previousChange?: { start: TokenCounts; calls: Call[]; closingId?: string };

  private constructor(private readonly fork?: CodexForkUsage) {}

  static resume(state?: unknown, fork?: CodexForkUsage): CodexUsage {
    const usage = new CodexUsage(fork);
    if (state === undefined) return usage;
    const saved = stateRecord(state, ["historyId", "baseline", "turnId", "model", "requestId", "seen", "pending",
      "disputed", "observations", "awaitingBaseline", "fork", "aliases", "previousChange"]);
    if (fork) fork.restore(saved.fork);
    else if (saved.fork !== undefined) invalidState();
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
    usage.restoreAliases(saved);
    if (usage.needsBaseline && usage.pending.size) invalidState();
    return usage;
  }

  private restoreAliases(saved: Record<string, unknown>): void {
    if (saved.aliases !== undefined) for (const [alias, ids] of Object.entries(stateRecord(saved.aliases))) {
      if (!validCallId(alias) || !Array.isArray(ids) || !ids.length || !ids.every(validCallId)) invalidState();
      this.aliases.set(alias, new Set(ids));
    }
    if (saved.previousChange !== undefined) {
      const { start, calls, closingId } = stateRecord(saved.previousChange, ["start", "calls", "closingId"]);
      if (!this.baseline || !Array.isArray(calls) || (closingId !== undefined && !validCallId(closingId))) invalidState();
      this.previousChange = { start: restoredCounts(start), calls: calls.map(restoreCall), closingId };
    }
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
      pending: Array.from(this.pending.values(), savedCall),
      ...(this.aliases.size && { aliases: Object.fromEntries([...this.aliases].map(([id, keys]) => [id, [...keys]])) }),
      ...(this.previousChange && { previousChange: { ...this.previousChange, calls: this.previousChange.calls.map(savedCall) } }),
      ...(this.fork && { fork: this.fork.snapshot() }),
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
      if (this.fork?.plan.firstUncertain?.lineNumber === line.lineNumber) {
        (result.usageDiagnostics ??= []).push({ code: "unresolved-codex-fork", sourceOrder: line.lineNumber,
          byteRange: { startOffset: line.startOffset, endOffset: line.endOffset } });
      }
      this.interrupt();
      this.fork?.interrupt();
      this.context = {};
      result.hasGap = true;
    }
    while (index < entries.length) this.read(entries[index++], result);
    return result;
  }

  private interrupt(): void {
    this.needsBaseline = true;
    this.previousChange = undefined;
    // These native calls have already been published. They cannot partition a change across the gap.
    this.pending.clear();
  }

  private startHistory(entry: UsageEntry, payload: Fields | undefined): void {
    this.historyId = this.fork?.historyId(entry.sessionId) ?? initialHistory(entry, payload);
    const seed = this.fork?.plan.baseline;
    if (seed) {
      this.baseline = { ...seed };
      this.lastObservation = jsonDigest([this.historyId, "fork-boundary", seed.inputTokens, seed.outputTokens]);
      this.observations.add(this.lastObservation);
    } else if (this.fork?.plan.inheritedThrough) this.needsBaseline = true;
  }

  private read(entry: UsageEntry, result: Result): void {
    const payload = object(entry.record.payload);
    if (!this.historyId) this.startHistory(entry, payload);
    if (this.fork?.plan.firstUncertain?.lineNumber === entry.lineNumber) diagnose(result, "unresolved-codex-fork", entry.lineNumber);
    if (!payload) return;
    const inherited = this.fork?.inherited(entry.lineNumber);
    if (!inherited) this.fork?.turn.observe(entry, payload);
    this.context = reportContext(entry, payload, this.context, Boolean(this.fork));
    if (entry.record.type !== "token_usage_record" && (entry.record.type !== "event_msg" || payload.type !== "token_count")) return;
    const report = readReport(entry, payload, this.context, this.historyId);
    if (report?.ownerThread && report.ownerThread !== entry.sessionId) return;
    if (inherited && !report?.ownerThread) {
      // Keep native identity if the inherited request is repeated in the child's suffix.
      if (report?.independent && report.last) this.remember(report.last);
      if (entry.lineNumber === this.fork?.plan.inheritedThrough?.lineNumber) this.context = {};
      return;
    }
    if (report === undefined) return;
    this.measure(entry, report, result);
  }

  private measure(entry: UsageEntry, report: Report | null, result: Result): void {
    const first = report?.last && !this.seen.has(report.last.id) ? report.last.id : undefined;
    const located = !this.fork || this.fork.plan.inheritedThrough || report?.ownerThread === entry.sessionId || this.fork.turn.owns(report?.turnId);
    if (located && report?.last && report.independent) this.identify(report, entry, result);
    this.acceptReport(entry, report, result, first);
  }

  private identify(report: Report, entry: UsageEntry, result: Result): void {
    const call = report.last;
    if (!call) return;
    for (const alias of report.aliases ?? []) {
      const { startOffset, endOffset } = entry;
      const { inputTokens, outputTokens, responseId, turnId } = call;
      (result.codexCallAliases ??= []).push({ callUsageId: call.id, aliasUsageId: alias,
        ...(!validCallId(alias) && { closing: { inputTokens, outputTokens, ...(responseId && { responseId }), ...(turnId && { turnId }) } }),
        ...(startOffset !== undefined && endOffset !== undefined && { sourceOrder: entry.lineNumber, byteRange: { startOffset, endOffset } }) });
      if (!validCallId(alias)) continue;
      const ids = this.aliases.get(alias) ?? new Set<string>();
      const enriched = !ids.has(call.id);
      ids.add(call.id);
      this.aliases.set(alias, ids);
      if (ids.size > 1) continue;
      const earlier = this.seen.get(alias);
      if (earlier && sameTotals(earlier, call)) {
        this.seen.set(call.id, earlier);
        this.seen.delete(alias);
        const pending = this.pending.get(alias);
        if (pending) {
          this.pending.delete(alias);
          this.pending.set(call.id, { ...pending, id: call.id });
        }
      }
      const known = this.seen.get(call.id);
      if (enriched && known && sameTotals(known, call)) result.usage.push({ ...call });
    }
    const matches = this.aliases.get(call.id);
    if (matches?.size === 1) call.id = [...matches][0];
    if (matches && matches.size > 1) {
      diagnose(result, "ambiguous-codex-call", report.sourceOrder);
      report.last = undefined;
      report.independent = false;
    }
  }

  private acceptReport(entry: UsageEntry, report: Report | null, result: Result, first?: string): void {
    const id = report?.last?.id;
    const known = id !== undefined && this.seen.has(id);
    if (this.fork && !this.fork.plan.inheritedThrough) {
      if (!report || report.invalidTotal) diagnose(result, "unsupported-codex-usage", entry.lineNumber);
      if (report?.last && report.independent && (report.ownerThread === entry.sessionId || this.fork.turn.owns(report.turnId))) {
        this.standalone(report.last, result);
      }
    } else {
      this.applyReport(entry, report, known, result);
    }
    if (id && first === id && report?.providerId && this.seen.has(id) && (this.fork || this.historyId.startsWith("verified:"))) {
      (result.codexCallClaims ??= []).push({ providerId: report.providerId, usageId: id, ownerSessionId: entry.sessionId });
    }
  }

  private applyReport(entry: UsageEntry, report: Report | null, known: boolean, result: Result): void {
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
      if (this.fork?.startsFresh(report, this.pending, known)) {
        this.baseline = undefined;
        this.lastObservation = undefined;
        this.needsBaseline = false;
      }
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
      else if (independent && !this.seen.has(independent.id) && this.previousChange) {
        this.refineClosing(end, independent, report, result, this.previousChange);
      }
      return;
    }
    const window: UsageWindow = { historyId: this.historyId, start: { ...start }, end: { ...end }, parts: [] };
    if (this.lastObservation) window.boundaryObservations = { start: this.lastObservation, end: observation };
    this.closeWindow(window, end, change, report, result);
  }

  private refineClosing(end: TokenCounts, independent: Call, report: Report, result: Result,
    previous: { start: TokenCounts; calls: Call[]; closingId?: string }): void {
    const { start, calls, closingId } = previous;
    const closing = calls.find(call => call.id === closingId);
    const mirror = closing && Boolean(closing.responseId) !== Boolean(independent.responseId) && couldBeSameCall(closing, independent);
    if (!independent.responseId && !mirror) return;
    const delta = difference(end, start);
    const parts = [...calls.filter(call => !mirror || call !== closing), independent];
    const split = delta && partition(delta, parts);
    if (split) {
      const window: UsageWindow = { historyId: this.historyId, start, end, parts: [] };
      window.parts = this.parts(window, parts, split.remaining, report.at);
      result.usageWindows.push(window);
      this.remember(independent);
    } else {
      diagnose(result, "unsupported-codex-usage", report.sourceOrder);
      if (independent.responseId) this.standalone(independent, result);
    }
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
    this.previousChange = { start: window.start, calls: calls.filter(call => validCallId(call.id)),
      ...(last && validCallId(last.id) && { closingId: last.id }) };
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
    this.previousChange = undefined;
    this.baseline = end;
    this.needsBaseline = false;
    this.pending.clear();
    this.disputed.clear();
  }
}
