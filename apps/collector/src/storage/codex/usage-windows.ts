import type { StreamKey, TokenCounts, Usage, UsageAnchor, UsageWindow } from "../collector-storage.ts";
import { epochsWithSharedObservations, sharedCounterSpans } from "./observed-counter-spans.ts";
import { isIdentifier, isNativeCodexCall, isRecord, isTokenCounts, isUsage, mergeCodexCall } from "../batch-values.ts";

const breakdowns = ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const;
const quantities = ["inputTokens", "outputTokens", ...breakdowns] as const;

function position(left: TokenCounts, right: TokenCounts): number {
  return left.inputTokens - right.inputTokens || left.outputTokens - right.outputTokens;
}

function change(start: TokenCounts, end: TokenCounts, field: keyof TokenCounts): number | undefined {
  const before = start[field];
  const after = end[field];
  return before !== undefined && after !== undefined ? after - before : undefined;
}

function canFollow(start: TokenCounts, end: TokenCounts): boolean {
  return isTokenCounts({
    inputTokens: end.inputTokens - start.inputTokens, outputTokens: end.outputTokens - start.outputTokens,
    cacheReadTokens: change(start, end, "cacheReadTokens"),
    cacheWriteTokens: change(start, end, "cacheWriteTokens"),
    reasoningTokens: change(start, end, "reasoningTokens"),
  });
}

function sum(parts: readonly Usage[], field: keyof TokenCounts): { known: number; complete: boolean } {
  let known = 0;
  let complete = true;
  for (const part of parts) {
    const value = part[field];
    if (value === undefined) complete = false;
    else known += value;
  }
  return { known, complete };
}

function conserves(start: TokenCounts, end: TokenCounts, parts: readonly Usage[]): boolean {
  return quantities.every(field => {
    const delta = change(start, end, field);
    if (delta === undefined) return true;
    const { known, complete } = sum(parts, field);
    return known === delta || (!complete && known < delta);
  });
}

export function isUsageWindow(value: unknown): value is UsageWindow {
  if (!isRecord(value) || !isIdentifier(value.historyId) || !isTokenCounts(value.start)
    || !isTokenCounts(value.end) || !canFollow(value.start, value.end)
    || !Array.isArray(value.parts) || !value.parts.length) return false;
  if (value.boundaryObservations !== undefined) {
    const proof = value.boundaryObservations;
    if (!isRecord(proof) || Object.keys(proof).length !== 2
      || typeof proof.start !== "string" || !/^[0-9a-f]{64}$/.test(proof.start)
      || typeof proof.end !== "string" || !/^[0-9a-f]{64}$/.test(proof.end)) return false;
  }
  const ids = new Set<string>();
  for (const part of value.parts) {
    if (!isUsage(part) || part.kind === undefined || ids.has(part.id)) return false;
    ids.add(part.id);
  }
  return conserves(value.start, value.end, value.parts);
}

interface Interval {
  window: UsageWindow;
  sources: readonly string[];
  /** Accumulate smaller intervals here until their boundaries cover the whole window. */
  inside?: Interval[];
}

function partsOf(intervals: readonly Interval[]): Usage[] {
  return intervals.flatMap(({ window }) => window.parts);
}

function compatibleBreakdowns(known: readonly Usage[], proposed: readonly Usage[]): boolean {
  return breakdowns.every(field => {
    const left = sum(known, field);
    const right = sum(proposed, field);
    return (!left.complete || right.known <= left.known) && (!right.complete || left.known <= right.known);
  });
}

function calls(parts: readonly Usage[]): Map<string, Usage> {
  return new Map(parts.filter(part => part.kind === "call").map(call => [call.id, call]));
}

function unidentifiedTokens(part: Usage): boolean {
  return (part.inputTokens > 0 || part.outputTokens > 0) && !isNativeCodexCall(part);
}

function fitsInside(window: UsageWindow, partial: Interval[]): boolean {
  const known = partsOf(partial);
  const windowCalls = calls(window.parts);
  const unidentified: Usage[] = [];
  for (const [id, call] of calls(known)) {
    const same = windowCalls.get(id);
    if (same && !mergeCodexCall(same, call)) return false;
    if (!same) unidentified.push(call);
  }
  const intervals = window.parts.filter(part => part.kind === "interval");
  return quantities.every(field => {
    const whole = sum(window.parts, field);
    const available = sum(intervals, field);
    return (!whole.complete || sum(known, field).known <= whole.known)
      && (!available.complete || sum(unidentified, field).known <= available.known);
  });
}

function covers(intervals: readonly Interval[], window: UsageWindow): boolean {
  if (!intervals.length || position(intervals[0].window.start, window.start)
    || position(intervals[intervals.length - 1].window.end, window.end)) return false;
  return intervals.every(({ window: part }, index) => index === 0 || !position(intervals[index - 1].window.end, part.start));
}

/** Compare two complete descriptions of the same span. Keep each identified call in the accepted partition. */
function reconcile(known: Interval[], proposed: Interval[], whole: Pick<UsageWindow, "start" | "end">, preferPartition: boolean) {
  const currentParts = partsOf(known);
  const nextParts = partsOf(proposed);
  if (!conserves(whole.start, whole.end, currentParts) || !conserves(whole.start, whole.end, nextParts)
    || !compatibleBreakdowns(currentParts, nextParts)) return null;
  const previousCalls = calls(currentParts);
  const nextCalls = calls(nextParts);
  if (previousCalls.size !== currentParts.filter(part => part.kind === "call").length
    || nextCalls.size !== nextParts.filter(part => part.kind === "call").length) return null;
  const recordedCalls = new Map(previousCalls);
  for (const [id, later] of nextCalls) {
    const first = previousCalls.get(id);
    const call = first ? mergeCodexCall(first, later) : later;
    if (!call) return null;
    recordedCalls.set(id, call);
  }
  const losesCall = recordedCalls.size > nextCalls.size;
  const gainsCall = recordedCalls.size > previousCalls.size;
  if (losesCall && gainsCall) return null;
  const replace = !losesCall && (gainsCall || preferPartition);
  const [survivors, other] = replace ? [proposed, known] : [known, proposed];
  const commonSources = other[0].sources.filter(source => other.every(interval => interval.sources.includes(source)));
  const result = survivors.map(interval => {
    const { window, sources } = interval;
    const parts = window.parts.map(part => part.kind === "call" ? recordedCalls.get(part.id) ?? part : part);
    const added = commonSources.filter(source => !sources.includes(source));
    return { ...interval, window: { ...window, parts }, sources: added.length ? [...sources, ...added] : sources };
  });
  return result.every(({ window }) => conserves(window.start, window.end, window.parts))
    && conserves(whole.start, whole.end, partsOf(result)) ? result : null;
}

/** The first positive-width interval whose end lies after the new start. */
function firstOverlap(intervals: readonly Interval[], start: TokenCounts): number {
  let left = 0;
  let right = intervals.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (position(intervals[middle].window.end, start) <= 0) left = middle + 1;
    else right = middle;
  }
  return left;
}

function replaceIntervals(intervals: Interval[], first: number, count: number, selected: Interval[]): void {
  // A coarse window can cover more records than the engine accepts as individual function arguments.
  if (count !== selected.length) {
    const tail = intervals.splice(first + count);
    intervals.length = first;
    for (const interval of selected) intervals.push(interval);
    for (const interval of tail) intervals.push(interval);
    return;
  }
  selected.forEach((interval, index) => { intervals[first + index] = interval; });
}

/** Insert into one disjoint partition. Only this transaction's array may be changed. */
function insert(intervals: Interval[], incoming: Interval): boolean {
  const { window } = incoming;
  const first = firstOverlap(intervals, window.start);
  let limit = first;
  while (limit < intervals.length && position(intervals[limit].window.start, window.end) < 0) limit++;
  const before = intervals[first - 1]?.window;
  const after = intervals[limit]?.window;
  if ((before && !canFollow(before.end, window.start)) || (after && !canFollow(window.end, after.start))) return false;
  if (first === limit) {
    intervals.splice(first, 0, incoming);
    return true;
  }

  const established = intervals[first];
  const parent = established.window;
  if (limit === first + 1 && canFollow(parent.start, window.start) && canFollow(window.end, parent.end)) {
    if (position(parent.start, window.start) || position(window.end, parent.end)) {
      const inside = [...(established.inside ?? [])];
      if (!insert(inside, incoming)) return false;
      const staged = { ...established, inside };
      if (!covers(inside, parent)) {
        intervals[first] = staged;
        return true;
      }
      const refined = reconcile([staged], inside, parent, true);
      if (!refined) return false;
      replaceIntervals(intervals, first, 1, refined);
      return true;
    }
  }

  const covered = intervals.slice(first, limit);
  if (!canFollow(window.start, parent.start)
    || !canFollow(covered[covered.length - 1].window.end, window.end)) return false;
  if (!covers(covered, window)) {
    if (!fitsInside(window, covered)) return false;
    intervals.splice(first, covered.length, { ...incoming, inside: covered });
    return true;
  }
  const inside = covered.length === 1 ? established.inside : covered;
  const selected = reconcile(covered, [{ ...incoming, inside }], window, false);
  if (!selected) return false;
  replaceIntervals(intervals, first, covered.length, selected);
  return true;
}

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
    if (position(window.start, window.end)) return insert(this.intervals, { window, sources: [source] });
    const index = this.zeros.findIndex(known => !position(known.start, window.start));
    if (index < 0) {
      this.zeros.push(window);
      return true;
    }
    const previous = this.zeros[index];
    if (!canFollow(previous.start, window.start) || !canFollow(previous.end, window.end)) return false;
    const knownCalls = calls(previous.parts);
    for (const [id, call] of calls(window.parts)) {
      const known = knownCalls.get(id);
      const merged = known ? mergeCodexCall(known, call) : call;
      if (!merged) return false;
      knownCalls.set(id, merged);
    }
    if (knownCalls.size) this.zeros[index] = { ...previous, parts: [...knownCalls.values()] };
    return true;
  }

  measurements(): Usage[] {
    if (!this.zeros.length) return partsOf(this.intervals);
    return [...this.zeros, ...this.intervals.map(interval => interval.window)]
      .sort((left, right) => position(left.start, right.start) || position(left.end, right.end))
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
      if (window.parts.some(unidentifiedTokens)) {
        end = window.end;
        break;
      }
    }
    this.coarseEnds.set(key, end);
    return end;
  }
}

function streamIdentity(source: StreamKey, generation: number): string {
  return JSON.stringify([source.streamId, source.installationId ?? null, generation]);
}

function anonymousLast(window: UsageWindow): Usage | undefined {
  const matches = window.parts.filter(part => part.kind === "call" && /^call:[0-9a-f]{64}$/.test(part.id) && !isNativeCodexCall(part));
  return matches.length === 1 ? matches[0] : undefined;
}

/** The same closing report can name its anonymous last call differently in each counter epoch. */
function matchClosingCall(known: Interval[], proposed: Interval[], published: ReadonlySet<string>): void {
  const left = known[known.length - 1].window, right = proposed[proposed.length - 1].window;
  if (!left.boundaryObservations || left.boundaryObservations.end !== right.boundaryObservations?.end) return;
  const a = anonymousLast(left), b = anonymousLast(right);
  if (!a || !b || a.id === b.id) return;
  const [accepted, other] = published.has(b.id) ? [b, a] : [a, b];
  const call = mergeCodexCall(accepted, { ...other, id: accepted.id });
  if (!call) return;
  for (const [intervals, original] of [[known, a], [proposed, b]] as const) {
    const index = intervals.length - 1;
    const { window } = intervals[index];
    const parts = window.parts.map(part => part === original ? call : part);
    intervals[index] = { ...intervals[index], window: { ...window, parts } };
  }
}

/** Publish the same measured span once when a damaged copy missed the reset that named its epoch. */
function measuredParts(histories: Map<string, CounterHistory>, previous: readonly Usage[]): Usage[] {
  if (histories.size < 2) return [...histories.values()].flatMap(history => history.measurements());
  const published = new Set(previous.map(part => part.id));
  const selected = new Map(histories);
  for (const [first, second] of epochsWithSharedObservations(histories)) {
    const left = selected.get(first);
    const right = selected.get(second);
    if (!left || !right) continue;
    const common = sharedCounterSpans(left.intervals, right.intervals);
    if (!common.length) continue;
    const merged = new CounterHistory(left);
    const remaining = new CounterHistory(right);
    for (const span of common) {
      const known = left.intervals.slice(span.left.first, span.left.limit);
      const proposed = right.intervals.slice(span.right.first, span.right.limit);
      if (!span.verified) {
        // Keep the previously published span until we can place the competing measurements.
        if (!partsOf(known).some(part => published.has(part.id)) && partsOf(proposed).some(part => published.has(part.id))) {
          replaceIntervals(merged.intervals, span.left.first, known.length, []);
        } else replaceIntervals(remaining.intervals, span.right.first, proposed.length, []);
        continue;
      }
      const whole = { start: known[0].window.start, end: known[known.length - 1].window.end };
      matchClosingCall(known, proposed, published);
      const parts = reconcile(known, proposed, whole, proposed.length > known.length) ?? known;
      replaceIntervals(merged.intervals, span.left.first, known.length, parts);
      replaceIntervals(remaining.intervals, span.right.first, proposed.length, []);
    }
    selected.set(first, merged);
    selected.set(second, remaining);
  }
  return [...selected.values()].flatMap(history => history.measurements());
}

function lineage(historyId: string, source: string): string {
  // The decoder names a reset as a new epoch under its original history. An
  // unverified origin belongs only to the transcript generation that supplied it.
  const base = historyId.split(":reset:", 1)[0];
  return JSON.stringify(base.startsWith("unverified:") ? [base, source] : [base]);
}

function canStartEpoch(historyId: string, latest: string | undefined, seen: string | undefined): boolean {
  return !historyId.includes(":reset:") || latest === undefined || latest === seen;
}

interface WindowState {
  histories: Map<string, CounterHistory>;
  epochsByStream: Map<string, string>;
  unmatchedCalls: Map<string, Usage>;
  origin?: string;
  latestEpoch?: string;
  hasGap: boolean;
}

function matchesHistory(state: WindowState, id: string, stream: string): boolean {
  return lineage(id, stream) === state.origin
    && (state.histories.has(id) || canStartEpoch(id, state.latestEpoch, state.epochsByStream.get(stream)));
}

function retainUnmatchedCalls(state: WindowState, parts: readonly Usage[]): void {
  state.hasGap = true;
  for (const part of parts.filter(isNativeCodexCall)) {
    const known = state.unmatchedCalls.get(part.id);
    const native = known ? mergeCodexCall(known, part) : structuredClone(part);
    if (native) state.unmatchedCalls.set(part.id, native);
  }
}

interface AnchoredCall {
  source: StreamKey;
  generation: number;
  anchor: UsageAnchor;
}

function groupPlacements(placements: readonly AnchoredCall[], field: "usageId" | "historyId"): Map<string, AnchoredCall[]> {
  const groups = new Map<string, AnchoredCall[]>();
  for (const placement of placements) {
    const id = placement.anchor[field];
    const group = groups.get(id);
    if (group) group.push(placement);
    else groups.set(id, [placement]);
  }
  return groups;
}

function copyState(previous?: WindowState): WindowState {
  return {
    histories: new Map(previous?.histories), epochsByStream: new Map(previous?.epochsByStream),
    unmatchedCalls: new Map(previous?.unmatchedCalls), hasGap: previous?.hasGap ?? false,
    origin: previous?.origin, latestEpoch: previous?.latestEpoch,
  };
}

export class UsageWindows {
  readonly measurements: readonly Usage[];
  private constructor(
    private readonly state: WindowState, private readonly visible: WindowState = state,
    private readonly pendingCalls: readonly AnchoredCall[] = [], previous: readonly Usage[] = [],
  ) {
    const published = measuredParts(visible.histories, previous);
    if (visible.unmatchedCalls.size && !published.some(unidentifiedTokens)) {
      const ids = new Set(published.map(part => part.id));
      for (const call of visible.unmatchedCalls.values()) if (!ids.has(call.id)) published.push(call);
    }
    this.measurements = published;
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
    const state = copyState(previous?.state);
    const writing = new Set<string>();
    const stream = streamIdentity(source, generation);
    for (const window of incoming) {
      if (!isUsageWindow(window)) return null;
      const id = window.historyId;
      state.origin ??= lineage(id, stream);
      if (!matchesHistory(state, id, stream)) {
        retainUnmatchedCalls(state, window.parts);
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
      else retainUnmatchedCalls(state, window.parts.filter(row => row.responseId));
    }
    const next = new UsageWindows(state, state, [], previous?.measurements);
    return next.preserveAcceptedCalls(previous, acceptedCalls);
  }

  private preserveAcceptedCalls(previous: UsageWindows | undefined, accepted: readonly AnchoredCall[]): UsageWindows {
    const recorded = previous?.pendingCalls ?? [];
    if (!accepted.length && !recorded.length) return this;
    const measured = new Set(this.measurements.filter(isNativeCodexCall).map(call => call.id));
    const pending = new Map<string, AnchoredCall>();
    const byId = groupPlacements([...recorded, ...accepted], "usageId");
    for (const [id, placements] of byId) {
      if (measured.has(id) || !this.mayCoverCall(placements)) continue;
      for (const call of placements) pending.set(JSON.stringify([streamIdentity(call.source, call.generation), call.anchor]), call);
    }
    if (!pending.size) return this;
    // Retain the proposed counters for a later partition. Publishing them now would hide a known native call.
    this.state.hasGap = true;
    const visible = copyState(previous?.visible);
    retainUnmatchedCalls(visible, this.measurements);
    return new UsageWindows(this.state, visible, [...pending.values()], previous?.measurements);
  }

  mayCover(anchor: UsageAnchor, source: StreamKey, generation = 0): boolean {
    return this.mayCoverCall([{ anchor, source, generation }]);
  }

  mayCoverCall(placements: readonly AnchoredCall[]): boolean {
    if (!placements.length || !this.visible.histories.size) return false;
    const matched = placements.filter(({ anchor, source, generation }) =>
      matchesHistory(this.visible, anchor.historyId, streamIdentity(source, generation)));
    const { histories } = this.visible;
    if (!matched.length) return [...histories.values()].some(history => history.coarseEnd() !== null);
    for (const [id, anchors] of groupPlacements(matched, "historyId")) {
      // Each copy that measured this native call separately accounts for it in its own intervals.
      const witnesses = new Set(anchors.map(({ source, generation }) => streamIdentity(source, generation)));
      const end = histories.get(id)?.coarseEnd(witnesses);
      if (end && !anchors.some(({ anchor }) => anchor.after && canFollow(end, anchor.after))) return true;
    }
    return false;
  }
}
