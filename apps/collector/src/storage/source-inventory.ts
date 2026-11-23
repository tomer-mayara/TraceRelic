import { matchesRecordedPath, recordedPathDialect } from "@tracerelic/shared";
import { isDeepStrictEqual } from "node:util";
import {
  LegacyScannerSource, SourceScopes, type AcknowledgedSource, type Batch, type Checkpoint, type CodexIdentityStatus, type MissingSource, type PresenceWrite,
  type ObservedExtent, type SourceLocation, type SourceObservation, type SourcePresence, type SourceScope, type StreamKey,
} from "./collector-storage.ts";
import { BatchValues } from "./batch-values.ts";

interface PresenceState {
  location?: SourceLocation;
  presence: SourcePresence;
  observedEnd: number;
  observedPrefixDigest?: string;
  unrecovered?: ObservedExtent;
  earlierGap: boolean;
  codexIdentityStatus?: CodexIdentityStatus;
  otherCodexEvidence?: true;
  unverifiedEarlierHistory?: true;
}

/** Unversioned LC-17 journal entries establish which rules govern this generation until its evidence is repaired. */
export interface SourceGeneration {
  generation: number;
  lc17Evidence: boolean;
}

type Dialect = NonNullable<ReturnType<typeof recordedPathDialect>>;

/** Keep each acknowledged source's presence and loss evidence with its checkpoint in the same transaction. */
export class StoredSource {
  private constructor(readonly source: StreamKey, readonly checkpoint: Checkpoint, readonly generation: number,
    private readonly state: PresenceState, readonly lc17Evidence: boolean) {}

  private static codexName(path: string, dialect: Dialect): boolean {
    return path === dialect.basename(path) && /^rollout-.*\.jsonl$/.test(path) && !path.includes("\0");
  }

  private static validLocation(source: StreamKey, root: string, path: string, projectDir: unknown): boolean {
    const dialect = recordedPathDialect(root);
    if (!dialect || path.includes("\0") || dialect.parse(path).root) return false;
    const separator = dialect.sep === "\\" ? /[/\\]/ : /\//;
    const parts = path.split(separator);
    if (parts.some(part => !part || part === ".." || part === ".")) return false;
    const same = (file: string) => matchesRecordedPath(dialect.join(root, file), dialect.join(root, path), true);
    if (source.harness === "codex") {
      return parts.length === 1 && projectDir === undefined && (!StoredSource.codexName(source.streamId, dialect) || same(source.streamId));
    }
    if (source.streamId.split(separator)[0] === "projects" && !same(source.streamId)) return false;
    if (projectDir === undefined) return true;
    const [projects, project] = parts;
    return projects === "projects" && !!project && matchesRecordedPath(dialect.join(root, projects, project), projectDir, true);
  }

  private static validProofs(end: number, digest: unknown, checked: unknown): boolean {
    const isDigest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
    if (digest !== undefined && !isDigest(digest)) return false;
    if (checked === undefined) return true;
    return BatchValues.isRecord(checked) && BatchValues.isCount(checked.offset) && checked.offset <= end && isDigest(checked.prefixDigest)
      && (checked.offset !== end || digest === undefined || checked.prefixDigest === digest);
  }

  private static validObservation(value: unknown, source: StreamKey, acceptedOffset: number, known?: SourceLocation): value is SourceObservation {
    if (!BatchValues.isRecord(value) || !BatchValues.isCount(value.observedEnd) || value.observedEnd < acceptedOffset || !BatchValues.isRecord(value.location)) return false;
    if (!StoredSource.validProofs(value.observedEnd, value.observedPrefixDigest, value.checkedPrefix)) return false;
    const { root, path, cwd, projectDir, currentFileCwd } = value.location;
    if (typeof root !== "string" || !BatchValues.isIdentifier(path) || !StoredSource.validLocation(source, root, path, projectDir)) return false;
    if (known && (known.path !== path || (source.installationId === undefined && known.root !== root))) return false;
    if (currentFileCwd !== undefined && (source.harness !== "claude" || !recordedPathDialect(currentFileCwd))) return false;
    return cwd === undefined || !!recordedPathDialect(cwd);
  }

  private static observedLocation(previous: SourceLocation | undefined, current: SourceLocation | undefined, sameGeneration = true): SourceLocation | undefined {
    if (!current) return previous;
    const known = sameGeneration && previous?.root === current.root && previous.path === current.path ? previous : undefined;
    return BatchValues.definedFields({ root: current.root, path: current.path, cwd: current.cwd ?? known?.cwd,
      projectDir: current.projectDir ?? known?.projectDir, currentFileCwd: current.currentFileCwd });
  }

  private static knownCompleteEnd(checkpoint: Checkpoint): number {
    const fork = checkpoint.codexFork?.inheritedThrough;
    return Math.max(checkpoint.offset, checkpoint.replayThrough?.offset ?? 0, fork?.prefixDigest ? fork.offset : 0);
  }

  private static consistentProof(checkpoint: Checkpoint, observation: SourceObservation): boolean {
    const { offset, prefixDigest } = checkpoint;
    if (!prefixDigest) return true;
    if (observation.observedEnd === offset && observation.observedPrefixDigest && observation.observedPrefixDigest !== prefixDigest) return false;
    const checked = observation.checkedPrefix;
    return checked?.offset !== offset || checked.prefixDigest === prefixDigest;
  }

  private static completeExtent(checkpoint: Checkpoint, observation?: SourceObservation, current?: PresenceState) {
    const observedEnd = Math.max(StoredSource.knownCompleteEnd(checkpoint), observation?.observedEnd ?? 0, current?.observedEnd ?? 0);
    const bound = [checkpoint.replayThrough, checkpoint.codexFork?.inheritedThrough].find(p => p?.offset === observedEnd && p.prefixDigest);
    const freshDigest = observation?.observedEnd === observedEnd ? observation.observedPrefixDigest : undefined;
    const savedDigest = current?.observedEnd === observedEnd ? current.observedPrefixDigest : undefined;
    return { observedEnd, observedPrefixDigest: freshDigest ?? savedDigest ?? bound?.prefixDigest };
  }

  private static outstandingExtent(batch: Batch, original?: ObservedExtent, outstanding?: ObservedExtent, lc17 = false): ObservedExtent | undefined {
    // LC-17 considered a recorded loss recovered once the same generation had accepted the entire suffix.
    if (lc17) return !batch.resetFrom && outstanding && outstanding.offset > batch.checkpoint.offset ? outstanding : undefined;
    if (!original?.prefixDigest) return outstanding;
    const { checkpoint } = batch;
    const checked = batch.sourceObservation?.checkedPrefix;
    const digest = checked?.offset === original.offset ? checked.prefixDigest : checkpoint.offset === original.offset ? checkpoint.prefixDigest : undefined;
    if (digest === original.prefixDigest && checkpoint.offset >= original.offset) return;
    return outstanding ?? (digest !== undefined && digest !== original.prefixDigest ? original : undefined);
  }

  private static recordLoss(previous: PresenceState, update: PresenceWrite, end: ObservedExtent, accepted: number) {
    const old = previous.unrecovered;
    const lost = update.presence === "missing" || update.observedEnd < previous.observedEnd;
    if (!lost || end.offset <= accepted || (old && end.offset <= old.offset)) return { unrecovered: old, earlierGap: previous.earlierGap };
    const checked = update.checkedPrefix;
    // The longer capture can account for a previous loss only when it includes its original bytes.
    const includesOld = !!old?.prefixDigest && checked?.offset === old.offset && checked.prefixDigest === old.prefixDigest;
    return { unrecovered: end, earlierGap: previous.earlierGap || (!!old && !includesOld) };
  }

  private static legacyCodexEvidence(batch: Batch, current?: PresenceState): Pick<PresenceState, "codexIdentityStatus" | "otherCodexEvidence"> {
    if (batch.checkpoint.evidenceVersion) return {};
    const recorded = [batch.usage, batch.usageWindows, batch.usageAnchors, batch.codexCallClaims, batch.usageDiagnostics, batch.codexCallAliases];
    const other = batch.source.harness === "codex" && (current?.otherCodexEvidence || recorded.some(items => items?.length)
      || batch.hasGap || batch.checkpoint.codexFork || Object.keys(batch.metadata ?? {}).length);
    return { ...(current?.codexIdentityStatus && { codexIdentityStatus: current.codexIdentityStatus }), ...(other && { otherCodexEvidence: true }) };
  }

  private static earlierHistory(prior: PresenceState | undefined, batch: Batch, location?: SourceLocation) {
    const earlierGap = prior?.earlierGap === true || (!!batch.resetFrom && !!prior?.unrecovered && !prior.unrecovered.prefixDigest);
    const unverified = prior?.unverifiedEarlierHistory || (batch.resetFrom && prior?.codexIdentityStatus !== "repaired"
      && LegacyScannerSource.needsHistoryVerification(batch.source, batch.resetFrom, prior?.location ?? location));
    return { earlierGap, ...(unverified && { unverifiedEarlierHistory: true as const }) };
  }

  static accept(previous: StoredSource | undefined, batch: Batch, generation: number, lc17Journal = false): StoredSource | null {
    const { source, checkpoint, sourceObservation } = batch;
    const prior = previous?.state;
    const known = prior?.location ?? (source.installationId === undefined ? LegacyScannerSource.location(source.harness, source.streamId) : undefined);
    if (sourceObservation !== undefined && (!StoredSource.validObservation(sourceObservation, source, StoredSource.knownCompleteEnd(checkpoint), known)
      || !StoredSource.consistentProof(checkpoint, sourceObservation))) return null;
    const reset = batch.resetFrom !== undefined;
    const current = reset ? undefined : prior;
    const location = StoredSource.observedLocation(known, sourceObservation?.location, !reset);
    const present = sourceObservation !== undefined || reset || checkpoint.offset > batch.expectedOffset;
    const state: PresenceState = {
      location, presence: present ? "present" : prior?.presence ?? "present",
      unrecovered: StoredSource.outstandingExtent(batch, previous?.observedThrough, prior?.unrecovered, lc17Journal),
      ...StoredSource.completeExtent(checkpoint, sourceObservation, current),
      ...StoredSource.legacyCodexEvidence(batch, current),
      ...StoredSource.earlierHistory(prior, batch, location),
    };
    const { harness, sessionId, streamId, installationId } = source;
    const key = previous?.source ?? BatchValues.definedFields({ harness, sessionId, streamId, installationId });
    const lc17Evidence = !checkpoint.evidenceVersion && (lc17Journal || (!reset && previous?.lc17Evidence === true));
    return new StoredSource(key, checkpoint, generation, state, lc17Evidence);
  }

  sharesEvidence(other: StoredSource): boolean {
    return this.generation === other.generation && this.lc17Evidence === other.lc17Evidence
      && !this.hasGap && !other.hasGap && !!this.checkpoint.prefixDigest
      && isDeepStrictEqual(this.checkpoint, other.checkpoint) && isDeepStrictEqual(this.state, other.state);
  }

  get hasGap(): boolean {
    return this.state.earlierGap || this.state.unrecovered !== undefined;
  }

  get unverifiedIdentity(): boolean {
    return this.state.codexIdentityStatus === "unverified" || this.state.codexIdentityStatus === "messages-repaired";
  }

  get repairedIdentity(): boolean { return this.state.codexIdentityStatus === "repaired"; }

  get repairedMessagesStatus(): CodexIdentityStatus {
    return this.state.otherCodexEvidence ? "messages-repaired" : "repaired";
  }

  get unverifiedHistory(): boolean {
    return this.state.unverifiedEarlierHistory === true ||
      (this.state.presence === "missing" && !this.repairedIdentity && LegacyScannerSource.needsHistoryVerification(this.source, this.checkpoint, this.state.location));
  }

  get observedThrough(): ObservedExtent | undefined {
    const { observedEnd, observedPrefixDigest, unrecovered } = this.state;
    return unrecovered ?? (observedEnd > this.checkpoint.offset ? BatchValues.definedFields({ offset: observedEnd, prefixDigest: observedPrefixDigest }) : undefined);
  }

  record(update: PresenceWrite, identity?: CodexIdentityStatus, lc17Journal = false): StoredSource | null {
    const accepted = this.checkpoint.offset;
    const previous = this.state;
    if ((update.presence !== "present" && update.presence !== "missing")
      || !StoredSource.validObservation(update, this.source, accepted, previous.location)) return null;
    let location = previous.location;
    if (update.presence === "missing") {
      if (location?.root !== update.location.root || location.path !== update.location.path) return null;
    } else location = StoredSource.observedLocation(location, update.location);
    const observedEnd = Math.max(previous.observedEnd, update.observedEnd);
    const observedPrefixDigest = update.observedEnd === observedEnd && update.observedPrefixDigest ? update.observedPrefixDigest :
      previous.observedEnd === observedEnd ? previous.observedPrefixDigest : undefined;
    const loss = lc17Journal && this.lc17Evidence
      ? { earlierGap: previous.earlierGap, unrecovered: update.presence === "missing" && observedEnd > accepted ? { offset: observedEnd } : previous.unrecovered }
      : StoredSource.recordLoss(previous, update, BatchValues.definedFields({ offset: observedEnd, prefixDigest: observedPrefixDigest }), accepted);
    const state = { ...previous, ...loss, presence: update.presence, location, observedEnd, observedPrefixDigest,
      ...(identity && { codexIdentityStatus: identity }) };
    return isDeepStrictEqual(state, previous) ? this : new StoredSource(this.source, this.checkpoint, this.generation, state, this.lc17Evidence);
  }

  selected(scope: SourceScope | undefined, version: number): AcknowledgedSource | undefined {
    const { location, observedEnd, presence } = this.state;
    if (!location || (scope && !SourceScopes.matches(scope, this.source, location))) return;
    const { observedPrefixDigest, unrecovered } = this.state;
    return { source: this.source, location, observedEnd, presence, version, acceptedOffset: this.checkpoint.offset,
      ...(this.state.codexIdentityStatus && { codexIdentityStatus: this.state.codexIdentityStatus }),
      ...(observedPrefixDigest && { generation: this.generation, observedPrefixDigest }), ...(unrecovered && { unrecovered }) };
  }

  missing(): MissingSource | undefined {
    if (this.state.presence === "missing") return { status: "missing", source: this.source,
      acceptedOffset: this.checkpoint.offset, observedEnd: this.state.observedEnd };
  }
}
