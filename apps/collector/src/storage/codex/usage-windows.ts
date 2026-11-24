import type { StreamKey, TokenCounts, Usage, UsageAnchor, UsageWindow } from "../collector-storage.ts";
import { ObservedCounterSpans } from "./observed-counter-spans.ts";
import { type Interval, UsageIntervals } from "./usage-intervals.ts";
import { BatchValues } from "../batch-values.ts";

class CounterHistory {
  readonly intervals: Interval[];
  // A measured zero may precede the first positive delta or identify a distinct zero-token call.
  readonly zeros: UsageWindow[];
  private readonly coarseEnds = new Map<string, TokenCounts | null>();

  constructor(previous?: CounterHistory) {
    this.intervals = [...(previous?.intervals ?? [])];
    this.zeros = [...(previous?.zeros ?? [])];
  }

  add(window: UsageWindow, source: string): boolean {
    if (UsageIntervals.position(window.start, window.end)) return UsageIntervals.insert(this.intervals, { window, sources: [source] });
    const index = this.zeros.findIndex(known => !UsageIntervals.position(known.start, window.start));
    if (index < 0) {
      this.zeros.push(window);
      return true;
    }
    const previous = this.zeros[index];
    if (!UsageIntervals.canFollow(previous.start, window.start) || !UsageIntervals.canFollow(previous.end, window.end)) return false;
    const knownCalls = UsageIntervals.calls(previous.parts);
    for (const [id, call] of UsageIntervals.calls(window.parts)) {
      const known = knownCalls.get(id);
      const merged = known ? BatchValues.mergeCodexCall(known, call) : call;
      if (!merged) return false;
      knownCalls.set(id, merged);
    }
    if (knownCalls.size) this.zeros[index] = { ...previous, parts: [...knownCalls.values()] };
    return true;
  }

  measurements(): Usage[] {
    if (!this.zeros.length) return UsageIntervals.partsOf(this.intervals);
    return [...this.zeros, ...this.intervals.map(interval => interval.window)]
      .sort((left, right) => UsageIntervals.position(left.start, right.start) || UsageIntervals.position(left.end, right.end))
      .flatMap(window => window.parts);
  }

  coarseEnd(excluding: ReadonlySet<string> = new Set()): TokenCounts | null {
    const key = JSON.stringify([...excluding].sort());
    const cached = this.coarseEnds.get(key);
    if (cached !== undefined) return cached;
    let end: TokenCounts | null = null;
    for (let i = this.intervals.length - 1; i >= 0; i--) {
      const { window, sources } = this.intervals[i];
      if (sources.some(source => excluding.has(source))) continue;
      if (window.parts.some(UsageIntervals.unidentifiedTokens)) {
        end = window.end;
        break;
      }
    }
    this.coarseEnds.set(key, end);
    return end;
  }
}

interface WindowState {
  histories: Map<string, CounterHistory>;
  epochsByStream: Map<string, string>;
  unmatchedCalls: Map<string, Usage>;
  origin?: string;
  latestEpoch?: string;
  hasGap: boolean;
}

interface AnchoredCall {
  source: StreamKey;
  generation: number;
  anchor: UsageAnchor;
}

export class UsageWindows {
  readonly measurements: readonly Usage[];
  private constructor(
    private readonly state: WindowState, private readonly visible: WindowState = state,
    private readonly pendingCalls: readonly AnchoredCall[] = [], previous: readonly Usage[] = [],
  ) {
    const published = UsageWindows.measuredParts(visible.histories, previous);
    if (visible.unmatchedCalls.size && !published.some(UsageIntervals.unidentifiedTokens)) {
      const ids = new Set(published.map(part => part.id));
      for (const call of visible.unmatchedCalls.values()) if (!ids.has(call.id)) published.push(call);
    }
    this.measurements = published;
  }

  static isWindow(value: unknown): value is UsageWindow {
    if (!BatchValues.isRecord(value) || !BatchValues.isIdentifier(value.historyId) || !BatchValues.isTokenCounts(value.start)
      || !BatchValues.isTokenCounts(value.end) || !UsageIntervals.canFollow(value.start, value.end)
      || !Array.isArray(value.parts) || !value.parts.length) return false;
    if (value.boundaryObservations !== undefined) {
      const proof = value.boundaryObservations;
      if (!BatchValues.isRecord(proof) || Object.keys(proof).length !== 2
        || typeof proof.start !== "string" || !/^[0-9a-f]{64}$/.test(proof.start)
        || typeof proof.end !== "string" || !/^[0-9a-f]{64}$/.test(proof.end)) return false;
    }
    const ids = new Set<string>();
    for (const part of value.parts) {
      if (!BatchValues.isUsage(part) || part.kind === undefined || ids.has(part.id)) return false;
      ids.add(part.id);
    }
    return UsageIntervals.conserves(value.start, value.end, value.parts);
  }

  private static streamIdentity(source: StreamKey, generation: number): string {
    return JSON.stringify([source.streamId, source.installationId ?? null, generation]);
  }

  private static anonymousLast(window: UsageWindow): Usage | undefined {
    const matches = window.parts.filter(part => part.kind === "call" && /^call:[0-9a-f]{64}$/.test(part.id) && !BatchValues.isNativeCodexCall(part));
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** The same closing report can name its anonymous last call differently in each counter epoch. */
  private static matchClosingCall(known: Interval[], proposed: Interval[], published: ReadonlySet<string>): void {
    const left = known[known.length - 1].window, right = proposed[proposed.length - 1].window;
    if (!left.boundaryObservations || left.boundaryObservations.end !== right.boundaryObservations?.end) return;
    const a = UsageWindows.anonymousLast(left), b = UsageWindows.anonymousLast(right);
    if (!a || !b || a.id === b.id) return;
    const [accepted, other] = published.has(b.id) ? [b, a] : [a, b];
    const call = BatchValues.mergeCodexCall(accepted, { ...other, id: accepted.id });
    if (!call) return;
    for (const [intervals, original] of [[known, a], [proposed, b]] as const) {
      const index = intervals.length - 1;
      const { window } = intervals[index];
      const parts = window.parts.map(part => part === original ? call : part);
      intervals[index] = { ...intervals[index], window: { ...window, parts } };
    }
  }

  /** Publish the same measured span once when a damaged copy missed the reset that named its epoch. */
  private static measuredParts(histories: Map<string, CounterHistory>, previous: readonly Usage[]): Usage[] {
    if (histories.size < 2) return [...histories.values()].flatMap(history => history.measurements());
    const published = new Set(previous.map(part => part.id));
    const selected = new Map(histories);
    for (const [first, second] of ObservedCounterSpans.epochsWithSharedObservations(histories)) {
      const left = selected.get(first);
      const right = selected.get(second);
      if (!left || !right) continue;
      const common = ObservedCounterSpans.shared(left.intervals, right.intervals);
      if (!common.length) continue;
      const merged = new CounterHistory(left);
      const remaining = new CounterHistory(right);
      for (const span of common) {
        const known = left.intervals.slice(span.left.first, span.left.limit);
        const proposed = right.intervals.slice(span.right.first, span.right.limit);
        if (!span.verified) {
          // Keep the previously published span until we can place the competing measurements.
          if (!UsageIntervals.partsOf(known).some(part => published.has(part.id)) && UsageIntervals.partsOf(proposed).some(part => published.has(part.id))) {
            UsageIntervals.replaceIntervals(merged.intervals, span.left.first, known.length, []);
          } else UsageIntervals.replaceIntervals(remaining.intervals, span.right.first, proposed.length, []);
          continue;
        }
        const whole = { start: known[0].window.start, end: known[known.length - 1].window.end };
        UsageWindows.matchClosingCall(known, proposed, published);
        const parts = UsageIntervals.reconcile(known, proposed, whole, proposed.length > known.length) ?? known;
        UsageIntervals.replaceIntervals(merged.intervals, span.left.first, known.length, parts);
        UsageIntervals.replaceIntervals(remaining.intervals, span.right.first, proposed.length, []);
      }
      selected.set(first, merged);
      selected.set(second, remaining);
    }
    return [...selected.values()].flatMap(history => history.measurements());
  }

  private static lineage(historyId: string, source: string): string {
    // The decoder names a reset as a new epoch under its original history. An
    // unverified origin belongs only to the transcript generation that supplied it.
    const base = historyId.split(":reset:", 1)[0];
    return JSON.stringify(base.startsWith("unverified:") ? [base, source] : [base]);
  }

  private static canStartEpoch(historyId: string, latest: string | undefined, seen: string | undefined): boolean {
    return !historyId.includes(":reset:") || latest === undefined || latest === seen;
  }

  private static matchesHistory(state: WindowState, id: string, stream: string): boolean {
    return UsageWindows.lineage(id, stream) === state.origin
      && (state.histories.has(id) || UsageWindows.canStartEpoch(id, state.latestEpoch, state.epochsByStream.get(stream)));
  }

  private static retainUnmatchedCalls(state: WindowState, parts: readonly Usage[]): void {
    state.hasGap = true;
    for (const part of parts.filter(BatchValues.isNativeCodexCall)) {
      const known = state.unmatchedCalls.get(part.id);
      const native = known ? BatchValues.mergeCodexCall(known, part) : structuredClone(part);
      if (native) state.unmatchedCalls.set(part.id, native);
    }
  }

  private static groupPlacements(placements: readonly AnchoredCall[], field: "usageId" | "historyId"): Map<string, AnchoredCall[]> {
    const groups = new Map<string, AnchoredCall[]>();
    for (const placement of placements) {
      const id = placement.anchor[field];
      const group = groups.get(id);
      if (group) group.push(placement);
      else groups.set(id, [placement]);
    }
    return groups;
  }

  private static copyState(previous?: WindowState): WindowState {
    return {
      histories: new Map(previous?.histories), epochsByStream: new Map(previous?.epochsByStream),
      unmatchedCalls: new Map(previous?.unmatchedCalls), hasGap: previous?.hasGap ?? false,
      origin: previous?.origin, latestEpoch: previous?.latestEpoch,
    };
  }

  get hasGap(): boolean {
    return this.state.hasGap;
  }

  get pendingNativeIds(): string[] {
    return this.pendingCalls.map(call => call.anchor.usageId);
  }

  static merge(
    previous: UsageWindows | undefined, incoming: readonly UsageWindow[], source: StreamKey, generation = 0,
    acceptedCalls: readonly AnchoredCall[] = [],
  ): UsageWindows | null {
    if (!Array.isArray(incoming)) return null;
    if (!incoming.length && previous && !(previous.pendingCalls.length && acceptedCalls.length)) return previous;
    const state = UsageWindows.copyState(previous?.state);
    const writing = new Set<string>();
    const stream = UsageWindows.streamIdentity(source, generation);
    for (const window of incoming) {
      if (!UsageWindows.isWindow(window)) return null;
      const id = window.historyId;
      state.origin ??= UsageWindows.lineage(id, stream);
      if (!UsageWindows.matchesHistory(state, id, stream)) {
        UsageWindows.retainUnmatchedCalls(state, window.parts);
        continue;
      }
      let history = state.histories.get(id);
      if (!history && (state.latestEpoch === undefined || id.includes(":reset:"))) state.latestEpoch = id;
      if (!history || !writing.has(id)) {
        history = new CounterHistory(history);
        state.histories.set(id, history);
        writing.add(id);
      }
      if (history.add(structuredClone(window), stream)) state.epochsByStream.set(stream, id);
      else UsageWindows.retainUnmatchedCalls(state, window.parts.filter(row => row.responseId));
    }
    const next = new UsageWindows(state, state, [], previous?.measurements);
    return next.preserveAcceptedCalls(previous, acceptedCalls);
  }

  private preserveAcceptedCalls(previous: UsageWindows | undefined, accepted: readonly AnchoredCall[]): UsageWindows {
    const recorded = previous?.pendingCalls ?? [];
    if (!accepted.length && !recorded.length) return this;
    const measured = new Set(this.measurements.filter(BatchValues.isNativeCodexCall).map(call => call.id));
    const pending = new Map<string, AnchoredCall>();
    const byId = UsageWindows.groupPlacements([...recorded, ...accepted], "usageId");
    for (const [id, placements] of byId) {
      if (measured.has(id) || !this.mayCoverCall(placements)) continue;
      for (const call of placements) pending.set(JSON.stringify([UsageWindows.streamIdentity(call.source, call.generation), call.anchor]), call);
    }
    if (!pending.size) return this;
    // Retain the proposed counters for a later partition. Publishing them now would hide a known native call.
    this.state.hasGap = true;
    const visible = UsageWindows.copyState(previous?.visible);
    UsageWindows.retainUnmatchedCalls(visible, this.measurements);
    return new UsageWindows(this.state, visible, [...pending.values()], previous?.measurements);
  }

  mayCoverCall(placements: readonly AnchoredCall[]): boolean {
    if (!placements.length || !this.visible.histories.size) return false;
    const matched = placements.filter(({ anchor, source, generation }) =>
      UsageWindows.matchesHistory(this.visible, anchor.historyId, UsageWindows.streamIdentity(source, generation)));
    const { histories } = this.visible;
    if (!matched.length) return [...histories.values()].some(history => history.coarseEnd() !== null);
    for (const [id, anchors] of UsageWindows.groupPlacements(matched, "historyId")) {
      // Each copy that measured this native call separately accounts for it in its own intervals.
      const witnesses = new Set(anchors.map(({ source, generation }) => UsageWindows.streamIdentity(source, generation)));
      const end = histories.get(id)?.coarseEnd(witnesses);
      if (end && !anchors.some(({ anchor }) => anchor.after && UsageIntervals.canFollow(end, anchor.after))) return true;
    }
    return false;
  }
}
