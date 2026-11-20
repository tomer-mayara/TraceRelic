import { isDeepStrictEqual } from "node:util";
import { ClaudeUsageLedger } from "./claude-usage-ledger.ts";
import type { ClaudeUsageReport, Usage } from "./collector-storage.ts";

interface Publication {
  at: string;
  revision: number;
  measurement?: Usage;
}

function sameReport(left: ClaudeUsageReport, right: ClaudeUsageReport): boolean {
  return left === right || isDeepStrictEqual(left, right);
}

function retainsReports(previous: readonly ClaudeUsageReport[], reports: readonly ClaudeUsageReport[]): boolean {
  let retained = 0;
  for (const row of reports) {
    if (retained < previous.length && sameReport(previous[retained], row)) retained++;
  }
  return retained === previous.length;
}

/** Apply the ordinary Claude whole-report rules after the workspace has identified each call's owner. */
export class ClaudeOwnedMeasurements {
  readonly measurements: readonly Usage[];
  readonly measurementIds: ReadonlySet<string>;
  private readonly slots: Map<string, Publication>;

  private constructor(previous: ClaudeOwnedMeasurements | undefined, private readonly reports: readonly ClaudeUsageReport[],
    private readonly ledger: ClaudeUsageLedger, readonly hasGap: boolean) {
    this.slots = new Map(previous?.slots);
    const ids = new Set(previous?.measurementIds);
    for (const id of ledger.measurementIds) ids.add(id);
    this.measurementIds = ids;
    const measured = new Set<string>();
    this.measurements = ledger.measurements.map(value => {
      measured.add(value.id);
      return this.publish(value);
    });
    for (const [id, slot] of this.slots) {
      if (slot.measurement && !measured.has(id)) this.slots.set(id, { at: slot.at, revision: slot.revision });
    }
  }

  static merge(previous: ClaudeOwnedMeasurements | undefined, sessionId: string, reports: readonly ClaudeUsageReport[]): ClaudeOwnedMeasurements {
    // An append can reuse the session ledger. New ownership evidence can withdraw, insert or reassign earlier observations.
    const append = previous && previous.reports.length <= reports.length &&
      previous.reports.every((value, i) => sameReport(value, reports[i]));
    if (append && previous.reports.length === reports.length) return previous;
    const additional = append ? reports.slice(previous.reports.length) : reports;
    const ledger = ClaudeUsageLedger.fromValidatedReports(append ? previous.ledger : undefined, additional, sessionId);
    const hasGap = ledger.hasGap || (previous?.hasGap === true && (append === true || retainsReports(previous.reports, reports)));
    return new ClaudeOwnedMeasurements(previous, reports, ledger, hasGap);
  }

  private publish(value: Usage): Usage {
    const old = this.slots.get(value.id);
    let measured = value;
    if (old) {
      measured = { ...value, at: old.at, revision: old.revision };
      if (old.measurement && isDeepStrictEqual(old.measurement, measured)) return old.measurement;
      measured.revision++;
    }
    this.slots.set(value.id, { at: measured.at, revision: measured.revision, measurement: measured });
    return measured;
  }
}
