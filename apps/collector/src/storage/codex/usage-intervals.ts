import type { TokenCounts, Usage, UsageWindow } from "../collector-storage.ts";
import { BatchValues } from "../batch-values.ts";

const breakdowns = ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const;
const quantities = ["inputTokens", "outputTokens", ...breakdowns] as const;

export interface Interval {
  window: UsageWindow;
  sources: readonly string[];
  /** Accumulate smaller intervals here until their boundaries cover the whole window. */
  inside?: Interval[];
}

/** The rules for the counter intervals of one Codex usage history. */
export class UsageIntervals {
  static position(left: TokenCounts, right: TokenCounts): number {
    return left.inputTokens - right.inputTokens || left.outputTokens - right.outputTokens;
  }

  private static change(start: TokenCounts, end: TokenCounts, field: keyof TokenCounts): number | undefined {
    const before = start[field];
    const after = end[field];
    return before !== undefined && after !== undefined ? after - before : undefined;
  }

  static canFollow(start: TokenCounts, end: TokenCounts): boolean {
    return BatchValues.isTokenCounts({
      inputTokens: end.inputTokens - start.inputTokens, outputTokens: end.outputTokens - start.outputTokens,
      cacheReadTokens: UsageIntervals.change(start, end, "cacheReadTokens"),
      cacheWriteTokens: UsageIntervals.change(start, end, "cacheWriteTokens"),
      reasoningTokens: UsageIntervals.change(start, end, "reasoningTokens"),
    });
  }

  private static sum(parts: readonly Usage[], field: keyof TokenCounts): { known: number; complete: boolean } {
    let known = 0;
    let complete = true;
    for (const part of parts) {
      const value = part[field];
      if (value === undefined) complete = false;
      else known += value;
    }
    return { known, complete };
  }

  static conserves(start: TokenCounts, end: TokenCounts, parts: readonly Usage[]): boolean {
    return quantities.every(field => {
      const delta = UsageIntervals.change(start, end, field);
      if (delta === undefined) return true;
      const { known, complete } = UsageIntervals.sum(parts, field);
      return known === delta || (!complete && known < delta);
    });
  }

  static partsOf(intervals: readonly Interval[]): Usage[] {
    return intervals.flatMap(({ window }) => window.parts);
  }

  private static compatibleBreakdowns(known: readonly Usage[], proposed: readonly Usage[]): boolean {
    return breakdowns.every(field => {
      const left = UsageIntervals.sum(known, field);
      const right = UsageIntervals.sum(proposed, field);
      return (!left.complete || right.known <= left.known) && (!right.complete || left.known <= right.known);
    });
  }

  static calls(parts: readonly Usage[]): Map<string, Usage> {
    return new Map(parts.filter(part => part.kind === "call").map(call => [call.id, call]));
  }

  static unidentifiedTokens(part: Usage): boolean {
    return (part.inputTokens > 0 || part.outputTokens > 0) && !BatchValues.isNativeCodexCall(part);
  }

  private static fitsInside(window: UsageWindow, partial: Interval[]): boolean {
    const known = UsageIntervals.partsOf(partial);
    const windowCalls = UsageIntervals.calls(window.parts);
    const unidentified: Usage[] = [];
    for (const [id, call] of UsageIntervals.calls(known)) {
      const same = windowCalls.get(id);
      if (same && !BatchValues.mergeCodexCall(same, call)) return false;
      if (!same) unidentified.push(call);
    }
    const intervals = window.parts.filter(part => part.kind === "interval");
    return quantities.every(field => {
      const whole = UsageIntervals.sum(window.parts, field);
      const available = UsageIntervals.sum(intervals, field);
      return (!whole.complete || UsageIntervals.sum(known, field).known <= whole.known)
        && (!available.complete || UsageIntervals.sum(unidentified, field).known <= available.known);
    });
  }

  private static covers(intervals: readonly Interval[], window: UsageWindow): boolean {
    if (!intervals.length || UsageIntervals.position(intervals[0].window.start, window.start)
      || UsageIntervals.position(intervals[intervals.length - 1].window.end, window.end)) return false;
    return intervals.every(({ window: part }, index) => index === 0 || !UsageIntervals.position(intervals[index - 1].window.end, part.start));
  }

  /** Compare two complete descriptions of the same span. Keep each identified call in the accepted partition. */
  static reconcile(known: Interval[], proposed: Interval[], whole: Pick<UsageWindow, "start" | "end">, preferPartition: boolean) {
    const currentParts = UsageIntervals.partsOf(known);
    const nextParts = UsageIntervals.partsOf(proposed);
    if (!UsageIntervals.conserves(whole.start, whole.end, currentParts) || !UsageIntervals.conserves(whole.start, whole.end, nextParts)
      || !UsageIntervals.compatibleBreakdowns(currentParts, nextParts)) return null;
    const previousCalls = UsageIntervals.calls(currentParts);
    const nextCalls = UsageIntervals.calls(nextParts);
    if (previousCalls.size !== currentParts.filter(part => part.kind === "call").length
      || nextCalls.size !== nextParts.filter(part => part.kind === "call").length) return null;
    const recordedCalls = new Map(previousCalls);
    for (const [id, later] of nextCalls) {
      const first = previousCalls.get(id);
      const call = first ? BatchValues.mergeCodexCall(first, later) : later;
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
    return result.every(({ window }) => UsageIntervals.conserves(window.start, window.end, window.parts))
      && UsageIntervals.conserves(whole.start, whole.end, UsageIntervals.partsOf(result)) ? result : null;
  }

  /** The first positive-width interval whose end lies after the new start. */
  private static firstOverlap(intervals: readonly Interval[], start: TokenCounts): number {
    let left = 0;
    let right = intervals.length;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (UsageIntervals.position(intervals[middle].window.end, start) <= 0) left = middle + 1;
      else right = middle;
    }
    return left;
  }

  static replaceIntervals(intervals: Interval[], first: number, count: number, selected: Interval[]): void {
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
  static insert(intervals: Interval[], incoming: Interval): boolean {
    const { window } = incoming;
    const first = UsageIntervals.firstOverlap(intervals, window.start);
    let limit = first;
    while (limit < intervals.length && UsageIntervals.position(intervals[limit].window.start, window.end) < 0) limit++;
    const before = intervals[first - 1]?.window;
    const after = intervals[limit]?.window;
    if ((before && !UsageIntervals.canFollow(before.end, window.start)) || (after && !UsageIntervals.canFollow(window.end, after.start))) return false;
    if (first === limit) {
      intervals.splice(first, 0, incoming);
      return true;
    }

    const established = intervals[first];
    const parent = established.window;
    if (limit === first + 1 && UsageIntervals.canFollow(parent.start, window.start) && UsageIntervals.canFollow(window.end, parent.end)) {
      if (UsageIntervals.position(parent.start, window.start) || UsageIntervals.position(window.end, parent.end)) {
        const inside = [...(established.inside ?? [])];
        if (!UsageIntervals.insert(inside, incoming)) return false;
        const staged = { ...established, inside };
        if (!UsageIntervals.covers(inside, parent)) {
          intervals[first] = staged;
          return true;
        }
        const refined = UsageIntervals.reconcile([staged], inside, parent, true);
        if (!refined) return false;
        UsageIntervals.replaceIntervals(intervals, first, 1, refined);
        return true;
      }
    }

    const covered = intervals.slice(first, limit);
    if (!UsageIntervals.canFollow(window.start, parent.start)
      || !UsageIntervals.canFollow(covered[covered.length - 1].window.end, window.end)) return false;
    if (!UsageIntervals.covers(covered, window)) {
      if (!UsageIntervals.fitsInside(window, covered)) return false;
      intervals.splice(first, covered.length, { ...incoming, inside: covered });
      return true;
    }
    const inside = covered.length === 1 ? established.inside : covered;
    const selected = UsageIntervals.reconcile(covered, [{ ...incoming, inside }], window, false);
    if (!selected) return false;
    UsageIntervals.replaceIntervals(intervals, first, covered.length, selected);
    return true;
  }
}
