import { isDeepStrictEqual } from "node:util";
import { ClaudeOriginReports, type OwnedReport } from "./claude-origin-reports.ts";
import { ClaudeOwnedMeasurements } from "./claude-owned-measurements.ts";
import { ClaudeSessionOwnership } from "./claude-session-ownership.ts";
import type { Batch, SourceUsageDiagnostic, Usage } from "./collector-storage.ts";

interface ClaudeProjection {
  usage: Usage[];
  diagnostics: SourceUsageDiagnostic[];
  hasGap?: true;
  conflictingUsageId?: true;
}

/** Store one workspace's native call origins. A prepared update becomes visible only when storage publishes it. */
export class ClaudeCallOwners {
  private readonly records: Map<string, ClaudeOriginReports>;
  private readonly children: Map<string, ReadonlySet<string>>;
  private readonly ownership: Map<string, ClaudeSessionOwnership>;
  private readonly contributors: Map<string, ReadonlySet<string>>;
  private readonly measured: Map<string, ClaudeOwnedMeasurements>;

  constructor(previous?: ClaudeCallOwners) {
    this.records = new Map(previous?.records);
    this.children = new Map(previous?.children);
    this.ownership = new Map(previous?.ownership);
    this.contributors = new Map(previous?.contributors);
    this.measured = new Map(previous?.measured);
  }

  prepare(batch: Batch, usage: readonly Usage[], parentSessionId?: string, generation = { generation: 0, lc17Evidence: false }): { owners: ClaudeCallOwners; changedSessions: ReadonlySet<string> } | null {
    const { sessionId } = batch.source;
    const previous = this.records.get(sessionId);
    if (!previous && !parentSessionId && !usage.length && !batch.claudeUsageReports?.length) {
      return { owners: this, changedSessions: new Set() };
    }
    const updated = ClaudeOriginReports.merge(previous, batch, usage, generation, parentSessionId);
    if (!updated) return null;
    if (updated === previous) return { owners: this, changedSessions: new Set() };
    const owners = new ClaudeCallOwners(this);
    owners.records.set(sessionId, updated);
    for (const parent of updated.parents) {
      if (!previous?.parents.has(parent)) owners.children.set(parent, new Set(owners.children.get(parent)).add(sessionId));
    }
    return { owners, changedSessions: owners.reassess(sessionId) };
  }

  private reassess(first: string): Set<string> {
    const changed = new Set<string>();
    const amounts = new Set<string>();
    const affected = new Set([first]);
    const lineage = new Map<string, boolean>();
    // Revisit only this session and descendants that may cite its evidence, with parents first.
    for (const sessionId of affected) {
      for (const child of this.children.get(sessionId) ?? []) affected.add(child);
      const records = this.records.get(sessionId);
      if (!records) continue;
      const parent = records.parentId;
      const prior = this.ownership.get(sessionId);
      const verified = parent && this.validLineage(sessionId, lineage) ? this.ownership.get(parent) : undefined;
      const next = new ClaudeSessionOwnership(sessionId, records, parent ? this.records.get(parent) : undefined, verified);
      next.recordChanges(prior, sessionId, changed);
      this.redistribute(sessionId, prior, next, amounts);
      this.ownership.set(sessionId, next);
    }
    for (const owner of amounts) this.publishAmounts(owner, changed);
    return changed;
  }

  private redistribute(source: string, prior: ClaudeSessionOwnership | undefined, next: ClaudeSessionOwnership, targets: Set<string>): void {
    const owners = new Set(prior?.contributions.keys());
    for (const owner of next.contributions.keys()) owners.add(owner);
    for (const owner of owners) {
      const before = prior?.contributions.get(owner);
      const after = next.contributions.get(owner);
      if (isDeepStrictEqual(before, after)) continue;
      targets.add(owner);
      if (owner === source || (before && after)) continue;
      const contributing = new Set(this.contributors.get(owner));
      if (after) contributing.add(source);
      else contributing.delete(source);
      this.contributors.set(owner, contributing);
    }
  }

  private publishAmounts(owner: string, changed: Set<string>): void {
    // Keep the owner's original observation first when a continuation contains a newer final amount.
    const reports: OwnedReport[] = [...this.ownership.get(owner)?.contributions.get(owner) ?? []];
    for (const child of [...this.contributors.get(owner) ?? []].sort()) {
      for (const row of this.ownership.get(child)?.contributions.get(owner) ?? []) reports.push(row);
    }
    const previous = this.measured.get(owner);
    const amounts = ClaudeOwnedMeasurements.merge(previous, owner, reports);
    if (!isDeepStrictEqual(amounts.measurements, previous?.measurements) || amounts.hasGap !== previous?.hasGap
      || !isDeepStrictEqual(amounts.diagnostics, previous?.diagnostics)) changed.add(owner);
    this.measured.set(owner, amounts);
  }

  private validLineage(first: string, known: Map<string, boolean>): boolean {
    const path = new Set<string>();
    let id: string | undefined = first;
    let valid = true;
    while (id !== undefined && !known.has(id)) {
      const records = this.records.get(id);
      if (path.has(id) || (records && records.parents.size > 1)) {
        valid = false;
        break;
      }
      path.add(id);
      id = records?.parentId;
    }
    if (id !== undefined && known.has(id)) valid = known.get(id) === true;
    for (const entry of path) known.set(entry, valid);
    return valid;
  }

  view(sessionId: string, usage: readonly Usage[], order?: ReadonlySet<string>): ClaudeProjection {
    const raw = this.records.get(sessionId);
    if (!raw) return { usage: [...usage], diagnostics: [] };
    const amounts = this.measured.get(sessionId);
    const diagnostics = [...this.ownership.get(sessionId)?.diagnostics ?? []]
      .sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
    for (const diagnostic of amounts?.diagnostics ?? []) diagnostics.push(diagnostic);
    const rows = new Map(usage.filter(row => !raw.rawIds.has(row.id)).map(row => [row.id, row]));
    const conflict = amounts && [...rows.keys()].some(id => amounts.measurementIds.has(id));
    for (const row of amounts?.measurements ?? []) rows.set(row.id, row);
    const ids = new Set(order ?? usage.map(row => row.id));
    for (const id of rows.keys()) ids.add(id);
    const visible: Usage[] = [];
    for (const id of ids) {
      const row = rows.get(id);
      if (row) visible.push(row);
    }
    return { usage: visible, diagnostics, ...(amounts?.hasGap && { hasGap: true }), ...(conflict && { conflictingUsageId: true }) };
  }
}
