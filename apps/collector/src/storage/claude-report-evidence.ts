import type { ClaudeUsageReport } from "./collector-storage.ts";

const counts = ["outputTokens", "cacheReadTokens", "cacheWriteTokens", "cacheWrite5mTokens",
  "cacheWrite1hTokens", "reasoningTokens"] as const;

function ordinary(report: ClaudeUsageReport): number {
  return report.inputTokens - (report.cacheReadTokens ?? 0) - (report.cacheWriteTokens ?? 0);
}

/** A final observation or a compatible refinement can supersede a complete earlier report. */
function covers(candidate: ClaudeUsageReport, earlier: ClaudeUsageReport): boolean {
  if (candidate.status !== earlier.status) return candidate.status === "final";
  const known = counts.filter(field => earlier[field] !== undefined);
  if (known.some(field => candidate[field] === undefined)) return false;
  const moreFields = counts.some(field => earlier[field] === undefined && candidate[field] !== undefined);
  if (moreFields || candidate.status === "final") {
    return ordinary(candidate) === ordinary(earlier) && known.every(field => candidate[field] === earlier[field]);
  }
  return ordinary(candidate) >= ordinary(earlier) && known.every(field => (candidate[field] ?? 0) >= (earlier[field] ?? 0));
}

function sameCountsAndStatus(a: ClaudeUsageReport, b: ClaudeUsageReport): boolean {
  return a.status === b.status && a.inputTokens === b.inputTokens && counts.every(field => a[field] === b[field]);
}

function copyReport(incoming: ClaudeUsageReport): ClaudeUsageReport {
  const { at, status, inputTokens, outputTokens } = incoming;
  const report: ClaudeUsageReport = { at, status, inputTokens, outputTokens };
  for (const field of [...counts, "messageId", "requestId", "iterationId", "model", "turnId"] as const) {
    if (incoming[field] !== undefined) Object.assign(report, { [field]: incoming[field] });
  }
  return report;
}

export class ClaudeReportEvidence {
  readonly first: ClaudeUsageReport;
  readonly order: number;
  private readonly reports: readonly ClaudeUsageReport[];
  private readonly strongest: readonly ClaudeUsageReport[];

  private constructor(first: ClaudeUsageReport, order: number, reports: ClaudeUsageReport[], strongest: ClaudeUsageReport[]) {
    this.first = first;
    this.order = order;
    this.reports = reports;
    this.strongest = strongest;
  }

  static append(old: ClaudeReportEvidence | undefined, incoming: ClaudeUsageReport, order: number): ClaudeReportEvidence {
    const report = copyReport(incoming);
    if (!old) return new ClaudeReportEvidence(report, order, [report], [report]);
    const matching = old.reports.filter(known => sameCountsAndStatus(known, report));
    if (matching.some(known => known.model === report.model && known.turnId === report.turnId)) return old;
    const reports = [...old.reports, report];
    if (matching.length) return new ClaudeReportEvidence(old.first, old.order, reports, [...old.strongest]);
    // Intermediate reports can prove that an older sparse update led to a richer, larger one.
    const strongest = old.strongest.filter(known => !covers(report, known));
    if (!old.reports.some(known => covers(known, report))) strongest.push(report);
    return new ClaudeReportEvidence(old.first, old.order, reports, strongest);
  }

  static select(groups: readonly ClaudeReportEvidence[]): ClaudeUsageReport | undefined {
    const winner = this.strongestReport(groups);
    if (!winner) return;
    const selected = { ...winner };
    const reports = groups.flatMap(group => group.reports);
    // A missing model or turn can come from another observation of this call when the sources agree.
    const matching = reports.filter(report => sameCountsAndStatus(report, winner));
    for (const field of ["model", "turnId"] as const) {
      const direct = matching.map(row => row[field]).filter(value => value !== undefined);
      const known = new Set(direct.length ? direct : reports.map(row => row[field]).filter(value => value !== undefined));
      if (known.size === 1) selected[field] = [...known][0];
      else delete selected[field];
    }
    return selected;
  }

  private static strongestReport(groups: readonly ClaudeReportEvidence[]): ClaudeUsageReport | undefined {
    const [first] = groups;
    if (groups.length === 1) return first.strongest.length === 1 ? first.strongest[0] : undefined;
    let winner: ClaudeUsageReport | undefined;
    for (const group of groups) {
      for (const candidate of group.strongest) {
        if (groups.some(other => other !== group && other.reports.some(r => !sameCountsAndStatus(r, candidate) && covers(r, candidate)))) continue;
        if (winner && !sameCountsAndStatus(winner, candidate)) return;
        winner ??= candidate;
      }
    }
    return winner;
  }
}
