import type { StreamKey, TokenCounts, Usage, UsageAnchor, UsageWindow } from "./collector-storage.ts";
import { isIdentifier, isNativeCodexCall, isRecord, isTokenCounts, isUsage, mergeCodexCall } from "./usage-validation.ts";

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

function isWindow(value: unknown): value is UsageWindow {
  if (!isRecord(value) || !isIdentifier(value.historyId) || !isTokenCounts(value.start)
    || !isTokenCounts(value.end) || !canFollow(value.start, value.end)
    || !Array.isArray(value.parts) || !value.parts.length) return false;
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
function reconcile(known: Interval[], proposed: Interval[], whole: UsageWindow, preferPartition: boolean) {
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
  private readonly coarseEnds = new Map<string | undefined, TokenCounts | null>();

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

  coarseEnd(excluding?: string): TokenCounts | null {
    const cached = this.coarseEnds.get(excluding);
    if (cached !== undefined) return cached;
    let end: TokenCounts | null = null;
    for (let i = this.intervals.length - 1; i >= 0; i--) {
      const { window, sources } = this.intervals[i];
      if (excluding !== undefined && sources.includes(excluding)) continue;
      if (window.parts.some(unidentifiedTokens)) {
        end = window.end;
        break;
      }
    }
    this.coarseEnds.set(excluding, end);
    return end;
  }
}

function streamIdentity(source: StreamKey): string {
  return JSON.stringify([source.streamId, source.installationId ?? null]);
}

function lineage(historyId: string, source: string): string {
  // The decoder names a reset as a new epoch under its original history. An
  // unverified origin belongs only to its physical stream and installation.
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

function retainUnmatchedCalls(state: WindowState, parts: Usage[]): void {
  state.hasGap = true;
  for (const part of parts.filter(isNativeCodexCall)) {
    const known = state.unmatchedCalls.get(part.id);
    const native = known ? mergeCodexCall(known, part) : structuredClone(part);
    if (native) state.unmatchedCalls.set(part.id, native);
  }
}

export class UsageWindows {
  readonly measurements: readonly Usage[];
  private readonly state: WindowState;

  private constructor(state: WindowState) {
    this.state = state;
    const published = [...state.histories.values()].flatMap(history => history.measurements());
    if (state.unmatchedCalls.size && !published.some(unidentifiedTokens)) {
      const ids = new Set(published.map(part => part.id));
      for (const call of state.unmatchedCalls.values()) if (!ids.has(call.id)) published.push(call);
    }
    this.measurements = published;
  }

  get hasGap(): boolean {
    return this.state.hasGap;
  }

  static merge(previous: UsageWindows | undefined, incoming: readonly UsageWindow[], source: StreamKey): UsageWindows | null {
    if (!Array.isArray(incoming)) return null;
    if (!incoming.length && previous) return previous;
    const before = previous?.state;
    const state: WindowState = {
      histories: new Map(before?.histories), epochsByStream: new Map(before?.epochsByStream),
      unmatchedCalls: new Map(before?.unmatchedCalls), hasGap: before?.hasGap ?? false,
      origin: before?.origin, latestEpoch: before?.latestEpoch,
    };
    const writing = new Set<string>();
    const stream = streamIdentity(source);
    for (const window of incoming) {
      if (!isWindow(window)) return null;
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
      else state.hasGap = true;
    }
    return new UsageWindows(state);
  }

  mayCover(anchor: UsageAnchor, source: StreamKey): boolean {
    const stream = streamIdentity(source);
    const { histories } = this.state;
    if (!matchesHistory(this.state, anchor.historyId, stream)) {
      return [...histories.values()].some(history => history.coarseEnd() !== null);
    }
    const end = histories.get(anchor.historyId)?.coarseEnd(stream);
    return end !== null && end !== undefined && (anchor.after === undefined || !canFollow(end, anchor.after));
  }
}
