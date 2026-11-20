import { isDeepStrictEqual } from "node:util";
import { ClaudeAdvisorIterations } from "./claude-advisor-iterations.ts";
import type { OwnedReport } from "./claude-origin-reports.ts";
import { ClaudeUsageLedger } from "./claude-usage-ledger.ts";
import type { ClaudeUsageReport, SourceUsageDiagnostic, Usage } from "./collector-storage.ts";

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
  readonly diagnostics: SourceUsageDiagnostic[];
  private readonly slots: Map<string, Publication>;

  private constructor(previous: ClaudeOwnedMeasurements | undefined, private readonly reports: readonly OwnedReport[],
    private readonly ledger: ClaudeUsageLedger, readonly hasGap: boolean, advisors?: ClaudeAdvisorIterations) {
    this.slots = new Map(previous?.slots);
    const ambiguous = new Map<string, SourceUsageDiagnostic>();
    for (const row of advisors?.unresolved ?? []) {
      if (!row.origin) continue;
      const { streamId, installationId, sourceOrder, byteRange } = row.origin;
      const key = JSON.stringify([streamId, installationId]);
      const existing = ambiguous.get(key);
      if (!existing || sourceOrder < existing.sourceOrder) ambiguous.set(key, {
        code: "ambiguous-claude-iteration", streamId, ...(installationId !== undefined && { installationId }), sourceOrder, byteRange,
      });
    }
    this.diagnostics = [...ambiguous.values()];
    const ids = new Set(previous?.measurementIds);
    for (const id of ledger.measurementIds) ids.add(id);
    this.measurementIds = ids;
    const measured = new Set<string>();
    this.measurements = ledger.measurements.map(value => {
      measured.add(value.id);
      return this.publish(advisors?.published(value) ?? value);
    });
    for (const [id, slot] of this.slots) {
      if (slot.measurement && !measured.has(id)) this.slots.set(id, { at: slot.at, revision: slot.revision });
    }
  }

  static merge(previous: ClaudeOwnedMeasurements | undefined, sessionId: string, reports: readonly OwnedReport[]): ClaudeOwnedMeasurements {
    // An append can reuse the session ledger. New ownership evidence can withdraw, insert or reassign earlier observations.
    const advisors = reports.some(row => row.iterationPosition !== undefined)
      ? new ClaudeAdvisorIterations(reports, previous?.ledger.measurements ?? []) : undefined;
    const normalized = advisors?.reports ?? reports;
    const append = previous && previous.reports.length <= normalized.length &&
      previous.reports.every((value, i) => sameReport(value, normalized[i]));
    if (append && previous.reports.length === normalized.length && !advisors) return previous;
    const additional = append ? normalized.slice(previous.reports.length) : normalized;
    const ledger = ClaudeUsageLedger.fromValidatedReports(append ? previous.ledger : undefined, additional, sessionId);
    const hasGap = ledger.hasGap || Boolean(advisors?.unresolved.length)
      || (previous?.ledger.hasGap === true && (append === true || retainsReports(previous.reports, normalized)));
    return new ClaudeOwnedMeasurements(previous, normalized, ledger, hasGap, advisors);
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
