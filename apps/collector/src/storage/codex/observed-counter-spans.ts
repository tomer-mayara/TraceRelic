import type { TokenCounts, UsageWindow } from "../collector-storage.ts";
import { UsageIntervals } from "./usage-intervals.ts";

interface ObservedInterval {
  window: UsageWindow;
  sources: readonly string[];
}

interface Span {
  first: number;
  limit: number;
}

interface OrderedInterval {
  start: TokenCounts;
  end: TokenCounts;
  from?: string;
  to?: string;
  sources: readonly string[];
  index: number;
}

/** The counter spans that two epochs of one native rollout recorded together. */
export class ObservedCounterSpans {
  private static observedBoundaries(intervals: readonly ObservedInterval[]): Set<string> {
    const observations = new Set<string>();
    for (const { window } of intervals) {
      const bounds = window.boundaryObservations;
      if (!bounds) continue;
      observations.add(bounds.start);
      observations.add(bounds.end);
    }
    return observations;
  }

  /** Only compare epochs from the same native rollout that share an actual provider observation. */
  static *epochsWithSharedObservations(histories: ReadonlyMap<string, { intervals: readonly ObservedInterval[] }>) {
    const owners = new Map<string, Set<string>>();
    for (const [id, history] of histories) {
      if (!id.startsWith("verified:")) continue;
      const root = id.split(":reset:", 1)[0];
      const earlier = new Set<string>();
      for (const observation of ObservedCounterSpans.observedBoundaries(history.intervals)) {
        const key = JSON.stringify([root, observation]);
        const previous = owners.get(key) ?? new Set<string>();
        for (const other of previous) earlier.add(other);
        previous.add(id);
        owners.set(key, previous);
      }
      for (const other of earlier) yield [other, id] as const;
    }
  }

  private static ordered(intervals: readonly ObservedInterval[], step: 1 | -1): OrderedInterval[] {
    const rows = intervals.map(({ window: { start, end, boundaryObservations }, sources }, index) => {
      const from = boundaryObservations?.start;
      const to = boundaryObservations?.end;
      return step === 1 ? { start, end, from, to, sources, index } : { start: end, end: start, from: to, to: from, sources, index };
    });
    return step === 1 ? rows : rows.reverse();
  }

  private static contiguous(windows: readonly OrderedInterval[], index: number): boolean {
    const current = windows[index];
    const next = windows[index + 1];
    return !!next && !!current.to && !UsageIntervals.position(current.end, next.start) && current.to === next.from;
  }

  /** Start at a shared observation. Stop at the next common boundary or where one copy runs out of evidence. */
  private static limits(left: OrderedInterval[], i: number, right: OrderedInterval[], j: number, step: 1 | -1) {
    for (;;) {
      const a = left[i], b = right[j];
      const order = step * UsageIntervals.position(a.end, b.end);
      const verified = !order && a.to === b.to;
      if (verified || (order <= 0 && !ObservedCounterSpans.contiguous(left, i)) || (order >= 0 && !ObservedCounterSpans.contiguous(right, j))) {
        return { left: i + 1, right: j + 1, verified };
      }
      if (order <= 0) i++;
      if (order >= 0) j++;
    }
  }

  private static sourceSpan(rows: OrderedInterval[], first: number, limit: number): Span {
    const a = rows[first].index, b = rows[limit - 1].index;
    return { first: Math.min(a, b), limit: Math.max(a, b) + 1 };
  }

  private static *fromSharedBoundary(left: OrderedInterval[], right: OrderedInterval[], step: 1 | -1) {
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
      const a = left[i], b = right[j];
      const order = step * UsageIntervals.position(a.start, b.start);
      if (!order && a.from && a.from === b.from
        && a.sources.some(source => b.sources.some(other => source !== other))) {
        const end = ObservedCounterSpans.limits(left, i, right, j, step);
        yield { left: ObservedCounterSpans.sourceSpan(left, i, end.left), right: ObservedCounterSpans.sourceSpan(right, j, end.right), verified: end.verified };
        i = end.left;
        j = end.right;
        continue;
      }
      if (order <= 0) i++;
      if (order >= 0) j++;
    }
  }

  private static overlaps(span: Span, claimed: Set<number>): boolean {
    for (let i = span.first; i < span.limit; i++) if (claimed.has(i)) return true;
    return false;
  }

  private static claim(span: Span, claimed: Set<number>): void {
    for (let i = span.first; i < span.limit; i++) claimed.add(i);
  }

  /** A second shared observation proves a span. One boundary can expose a possible overlap. */
  static shared(left: readonly ObservedInterval[], right: readonly ObservedInterval[]) {
    const candidates = [...ObservedCounterSpans.fromSharedBoundary(ObservedCounterSpans.ordered(left, 1), ObservedCounterSpans.ordered(right, 1), 1),
      ...ObservedCounterSpans.fromSharedBoundary(ObservedCounterSpans.ordered(left, -1), ObservedCounterSpans.ordered(right, -1), -1)];
    candidates.sort((a, b) => Number(b.verified) - Number(a.verified));
    const leftClaimed = new Set<number>(), rightClaimed = new Set<number>();
    const matches = candidates.filter(match => {
      if (ObservedCounterSpans.overlaps(match.left, leftClaimed) || ObservedCounterSpans.overlaps(match.right, rightClaimed)) return false;
      ObservedCounterSpans.claim(match.left, leftClaimed);
      ObservedCounterSpans.claim(match.right, rightClaimed);
      return true;
    });
    return matches.sort((a, b) => b.left.first - a.left.first);
  }
}
