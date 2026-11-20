import { isDeepStrictEqual } from "node:util";
import { ClaudeReportEvidence } from "./claude-report-evidence.ts";
import type { ClaudeUsageReport, Usage } from "./collector-storage.ts";
import { isClaudeUsageReport, isIdentifier } from "./usage-validation.ts";

type Identity = Pick<ClaudeUsageReport, "messageId" | "requestId">;
type Iterations = Map<string, ClaudeReportEvidence>;

interface RequestReports extends Identity {
  iterations: Iterations;
}

interface Slot {
  id: string;
  at: string;
  order: number;
  revision: number;
  measurement?: Usage;
}

function key(messageId?: string, requestId?: string): string {
  return JSON.stringify([messageId, requestId]);
}

function singleIds({ messageId, requestId }: Identity): string[] {
  return [key(messageId), key(undefined, requestId)];
}

function firstSlot(sessionId: string, groups: ClaudeReportEvidence[]): Slot {
  const earliest = groups.reduce((a, b) => a.order < b.order ? a : b);
  const { at, messageId, requestId, iterationId } = earliest.first;
  const id = "claude:" + JSON.stringify([sessionId, messageId, requestId, iterationId]);
  return { id, at, order: earliest.order, revision: 0 };
}

function accept(slot: Slot, winner: ClaudeUsageReport, owner: Identity): Slot {
  const { id, at, revision } = slot;
  const measurement: Usage = { ...winner, id, at, revision, kind: "call" };
  if (owner.messageId) measurement.messageId = owner.messageId;
  if (owner.requestId) measurement.requestId = owner.requestId;
  if (isDeepStrictEqual(slot.measurement, measurement)) return slot;
  measurement.revision++;
  return { ...slot, measurement, revision: measurement.revision };
}

export class ClaudeUsageLedger {
  readonly measurements: readonly Usage[];
  private readonly reports: Map<string, RequestReports>;
  // A single identifier maps to a unique pair, or to null when several observed pairs share it.
  private readonly pairs: Map<string, string | null>;
  private readonly slots: Map<string, Map<string, Slot>>;
  private readonly ids: Set<string>;
  private nextOrder: number;
  private gap: boolean;

  private constructor(previous: ClaudeUsageLedger | undefined, incoming: readonly ClaudeUsageReport[], sessionId: string) {
    this.reports = new Map(previous?.reports);
    this.pairs = new Map(previous?.pairs);
    this.slots = new Map(previous?.slots);
    this.ids = new Set(previous?.ids);
    this.nextOrder = previous?.nextOrder ?? 0;
    this.gap = previous?.hasGap ?? false;
    for (const report of incoming) this.observe(report, sessionId);
    const slots = [...this.slots.values()].flatMap(iterations => [...iterations.values()]);
    this.measurements = slots.sort((a, b) => a.order - b.order).flatMap(slot => slot.measurement ? [slot.measurement] : []);
  }

  get hasGap(): boolean {
    return this.gap;
  }

  /** Every reserved call ID in order of first observation, including withdrawn calls. */
  get measurementIds(): ReadonlySet<string> {
    return this.ids;
  }

  static merge(previous: ClaudeUsageLedger | undefined, reports: readonly ClaudeUsageReport[], sessionId: string): ClaudeUsageLedger | null {
    if (!isIdentifier(sessionId) || !Array.isArray(reports)) return null;
    for (const report of reports) if (!isClaudeUsageReport(report)) return null;
    if (!reports.length && previous) return previous;
    return new ClaudeUsageLedger(previous, reports, sessionId);
  }

  private observe(report: ClaudeUsageReport, sessionId: string): void {
    const { messageId, requestId } = report;
    const identity = key(messageId, requestId);
    const iteration = report.iterationId ?? "";
    const old = this.reports.get(identity);
    const previous = old?.iterations.get(iteration);
    const evidence = ClaudeReportEvidence.append(previous, report, this.nextOrder);
    if (evidence === previous) return;
    if (!previous) this.nextOrder++;
    const iterations = new Map(old?.iterations).set(iteration, evidence);
    const group = { messageId, requestId, iterations };
    this.reports.set(identity, group);
    if (messageId && requestId && !old) {
      for (const alias of singleIds(group)) this.indexPair(alias, identity, sessionId);
      this.refresh(identity, sessionId);
      return;
    }
    const match = this.pairs.get(identity);
    if (match === null) this.gap = true;
    else this.refresh(match ?? identity, sessionId, iteration);
  }

  private indexPair(alias: string, identity: string, sessionId: string): void {
    const old = this.pairs.get(alias);
    if (old === undefined) {
      this.pairs.set(alias, identity);
      this.adoptSlots(identity, alias);
    } else if (old !== null) {
      this.pairs.set(alias, null);
      // The earlier pair must now stand on its own evidence. A former single-ID update could belong to either.
      if (this.reports.has(alias)) {
        this.gap = true;
        this.refresh(old, sessionId);
      }
    }
  }

  private adoptSlots(identity: string, alias: string): void {
    const standalone = this.slots.get(alias);
    if (!standalone) return;
    const slots = new Map(this.slots.get(identity));
    for (const [iteration, slot] of standalone) {
      const present = slots.get(iteration);
      if (!present || slot.order < present.order) slots.set(iteration, slot);
    }
    this.slots.set(identity, slots);
    this.slots.delete(alias);
  }

  private contributors(identity: string, owner: RequestReports): RequestReports[] {
    const groups = [owner];
    if (owner.messageId && owner.requestId) {
      for (const alias of singleIds(owner)) {
        const single = this.reports.get(alias);
        if (single && this.pairs.get(alias) === identity) groups.push(single);
      }
    }
    return groups;
  }

  private refresh(identity: string, sessionId: string, changed?: string): void {
    const owner = this.reports.get(identity);
    if (!owner) return;
    const groups = this.contributors(identity, owner);
    const slots = new Map(this.slots.get(identity));
    const iterations = changed === undefined
      ? new Set([...slots.keys(), ...groups.flatMap(group => [...group.iterations.keys()])]) : [changed];
    for (const iteration of iterations) {
      const evidence = groups.map(group => group.iterations.get(iteration)).filter(group => group !== undefined);
      const slot = slots.get(iteration);
      if (!evidence.length) {
        if (slot) slots.set(iteration, { ...slot, measurement: undefined });
        continue;
      }
      const saved = slot ?? firstSlot(sessionId, evidence);
      this.ids.add(saved.id);
      const winner = ClaudeReportEvidence.select(evidence);
      if (!winner) this.gap = true;
      slots.set(iteration, winner ? accept(saved, winner, owner) : { ...saved, measurement: undefined });
    }
    this.slots.set(identity, slots);
  }
}
