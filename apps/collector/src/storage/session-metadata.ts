import { ClaudeTranscriptCopy, RecordedInstant, recordedPathDialect } from "@tracerelic/shared";
import type { Batch, BranchObservation, Metadata, SourceLocation } from "./collector-storage.ts";
import { isCount, isIdentifier, isRecord } from "./batch-values.ts";

const fields = ["cwd", "repository", "branch", "parentSessionId"] as const;
type Field = typeof fields[number];
type Observations = Partial<Record<Field, { value: string; version: number }>>;
type Branch = { name: string; line: number; instant?: ReturnType<typeof RecordedInstant.parse> };

export function hasValidMetadata(metadata: Metadata | undefined): boolean {
  if (metadata === undefined) return true;
  return isRecord(metadata) && fields.every(field => metadata[field] === undefined ||
    (field === "parentSessionId" ? isIdentifier(metadata[field]) : typeof metadata[field] === "string"));
}

/** Keep the most recent observation for each field in each source generation. */
export class SessionMetadata {
  private readonly sources: Map<string, Observations>;
  private readonly branches: Map<string, Branch>;
  private latestBranch?: string;
  readonly fields: Metadata = {};

  private constructor(previous?: SessionMetadata) {
    this.sources = new Map(previous?.sources);
    this.branches = new Map(previous?.branches);
    this.latestBranch = previous?.latestBranch;
  }

  /** The original writes record which fallback fields the backup supplied, and when. Both the view and call ownership use these fields. */
  restoreBackupFields(batch: Batch, source: string, location?: SourceLocation): void {
    if (!location || batch.source.harness !== "claude" || !hasValidMetadata(batch.metadata)) return;
    const filename = recordedPathDialect(location.root)?.basename(location.path);
    if (!filename || !ClaudeTranscriptCopy.stem(filename)) return;
    const metadata: Metadata = { ...batch.metadata };
    const prior = this.sources.get(source);
    for (const field of ClaudeTranscriptCopy.fallbackFields) {
      const accepted = prior?.[field];
      if (accepted) metadata[field] = accepted.value;
      else delete metadata[field];
    }
    batch.metadata = metadata;
  }

  static apply(previous: SessionMetadata | undefined, batch: Batch, source: string, version: number): SessionMetadata | null {
    if (!hasValidMetadata(batch.metadata)) return null;
    const repair = !!batch.repairEvidenceFrom;
    const observation = batch.branchObservation;
    const incoming = batch.metadata ?? {};
    if (!repair && observation === undefined && !fields.some(field => incoming[field] !== undefined)) return previous ?? new SessionMetadata();
    const next = new SessionMetadata(previous);
    next.recordFields(source, incoming, repair, version);
    if (repair) next.branches.delete(source);
    if (observation !== undefined && !next.recordBranch(source, incoming.branch, observation)) return null;
    next.selectBranch();
    return next;
  }

  private recordFields(source: string, incoming: Metadata, repair: boolean, version: number) {
    const prior = this.sources.get(source);
    const recorded: Observations = repair ? {} : { ...prior };
    for (const field of fields) {
      const value = incoming[field];
      if (value !== undefined) recorded[field] = { value, version: (repair && prior?.[field]?.version) || version };
    }
    this.sources.set(source, recorded);
    const latest: Observations = {};
    for (const row of this.sources.values()) for (const field of fields) {
      const item = row[field];
      if (item && item.version > (latest[field]?.version ?? 0)) {
        latest[field] = item;
        this.fields[field] = item.value;
      }
    }
  }

  private recordBranch(source: string, name: string | undefined, observation: BranchObservation): boolean {
    if (!isRecord(observation) || !isCount(observation.sourceOrder) || !observation.sourceOrder || !name) return false;
    const instant = observation.at === undefined ? undefined : RecordedInstant.parse(observation.at);
    if (observation.at !== undefined && !instant) return false;
    if (observation.sourceOrder > (this.branches.get(source)?.line ?? 0)) {
      this.branches.set(source, { name: name, line: observation.sourceOrder, instant });
    }
    return true;
  }

  private selectBranch() {
    // Line numbers order one source. Compare different sources only when both supply a time.
    let winner = this.latestBranch && this.branches.has(this.latestBranch) ? this.latestBranch : undefined;
    for (const [key, branch] of this.branches) {
      const before = winner && this.branches.get(winner)?.instant;
      const at = branch.instant;
      if (!winner || (at && before && (at.second > before.second || (at.second === before.second && at.fraction > before.fraction)))) winner = key;
    }
    this.latestBranch = winner;
    const branch = winner && this.branches.get(winner);
    if (branch) this.fields.branch = branch.name;
  }
}
