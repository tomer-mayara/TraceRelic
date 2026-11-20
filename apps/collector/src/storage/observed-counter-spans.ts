import type { TokenCounts, UsageWindow } from "./collector-storage.ts";

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

function compare(left: TokenCounts, right: TokenCounts): number {
  return left.inputTokens - right.inputTokens || left.outputTokens - right.outputTokens;
}

function observedBoundaries(intervals: readonly ObservedInterval[]): Set<string> {
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
export function* epochsWithSharedObservations(histories: ReadonlyMap<string, { intervals: readonly ObservedInterval[] }>) {
  const owners = new Map<string, Set<string>>();
  for (const [id, history] of histories) {
    if (!id.startsWith("verified:")) continue;
    const root = id.split(":reset:", 1)[0];
    const earlier = new Set<string>();
    for (const observation of observedBoundaries(history.intervals)) {
      const key = JSON.stringify([root, observation]);
      const previous = owners.get(key) ?? new Set<string>();
      for (const other of previous) earlier.add(other);
      previous.add(id);
      owners.set(key, previous);
    }
    for (const other of earlier) yield [other, id] as const;
  }
}

function ordered(intervals: readonly ObservedInterval[], step: 1 | -1): OrderedInterval[] {
  const rows = intervals.map(({ window: { start, end, boundaryObservations }, sources }, index) => {
    const from = boundaryObservations?.start;
    const to = boundaryObservations?.end;
    return step === 1 ? { start, end, from, to, sources, index } : { start: end, end: start, from: to, to: from, sources, index };
  });
  return step === 1 ? rows : rows.reverse();
}

function contiguous(windows: readonly OrderedInterval[], index: number): boolean {
  const current = windows[index];
  const next = windows[index + 1];
  return !!next && !!current.to && !compare(current.end, next.start) && current.to === next.from;
}

/** Start at a shared observation. Stop at the next common boundary or where one copy runs out of evidence. */
function limits(left: OrderedInterval[], i: number, right: OrderedInterval[], j: number, step: 1 | -1) {
  for (;;) {
    const a = left[i], b = right[j];
    const order = step * compare(a.end, b.end);
    const verified = !order && a.to === b.to;
    if (verified || (order <= 0 && !contiguous(left, i)) || (order >= 0 && !contiguous(right, j))) {
      return { left: i + 1, right: j + 1, verified };
    }
    if (order <= 0) i++;
    if (order >= 0) j++;
  }
}

function sourceSpan(rows: OrderedInterval[], first: number, limit: number): Span {
  const a = rows[first].index, b = rows[limit - 1].index;
  return { first: Math.min(a, b), limit: Math.max(a, b) + 1 };
}

function* fromSharedBoundary(left: OrderedInterval[], right: OrderedInterval[], step: 1 | -1) {
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const a = left[i], b = right[j];
    const order = step * compare(a.start, b.start);
    if (!order && a.from && a.from === b.from
      && a.sources.some(source => b.sources.some(other => source !== other))) {
      const end = limits(left, i, right, j, step);
      yield { left: sourceSpan(left, i, end.left), right: sourceSpan(right, j, end.right), verified: end.verified };
      i = end.left;
      j = end.right;
      continue;
    }
    if (order <= 0) i++;
    if (order >= 0) j++;
  }
}

function overlaps(span: Span, claimed: Set<number>): boolean {
  for (let i = span.first; i < span.limit; i++) if (claimed.has(i)) return true;
  return false;
}

function claim(span: Span, claimed: Set<number>): void {
  for (let i = span.first; i < span.limit; i++) claimed.add(i);
}

/** A second shared observation proves a span. One boundary can expose a possible overlap. */
export function sharedCounterSpans(left: readonly ObservedInterval[], right: readonly ObservedInterval[]) {
  const candidates = [...fromSharedBoundary(ordered(left, 1), ordered(right, 1), 1),
    ...fromSharedBoundary(ordered(left, -1), ordered(right, -1), -1)];
  candidates.sort((a, b) => Number(b.verified) - Number(a.verified));
  const leftClaimed = new Set<number>(), rightClaimed = new Set<number>();
  const matches = candidates.filter(match => {
    if (overlaps(match.left, leftClaimed) || overlaps(match.right, rightClaimed)) return false;
    claim(match.left, leftClaimed);
    claim(match.right, rightClaimed);
    return true;
  });
  return matches.sort((a, b) => b.left.first - a.left.first);
}
