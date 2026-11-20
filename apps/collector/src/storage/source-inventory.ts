import { matchesRecordedPath, recordedPathDialect } from "@tracerelic/shared";
import { isDeepStrictEqual } from "node:util";
import {
  legacyScannerLine, legacyScannerLocation, matchesSourceScope, type AcknowledgedSource, type Batch, type Checkpoint, type CodexIdentityStatus, type MissingSource, type PresenceWrite,
  type ObservedExtent, type SourceLocation, type SourceObservation, type SourcePresence, type SourceScope, type StreamKey,
} from "./collector-storage.ts";
import { definedFields, isCount, isIdentifier, isRecord } from "./usage-validation.ts";

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

type Dialect = NonNullable<ReturnType<typeof recordedPathDialect>>;

function codexName(path: string, dialect: Dialect): boolean {
  return path === dialect.basename(path) && /^rollout-.*\.jsonl$/.test(path) && !path.includes("\0");
}

function validLocation(source: StreamKey, root: string, path: string, projectDir: unknown): boolean {
  const dialect = recordedPathDialect(root);
  if (!dialect || path.includes("\0") || dialect.parse(path).root) return false;
  const separator = dialect.sep === "\\" ? /[/\\]/ : /\//;
  const parts = path.split(separator);
  if (parts.some(part => !part || part === ".." || part === ".")) return false;
  const same = (file: string) => matchesRecordedPath(dialect.join(root, file), dialect.join(root, path), true);
  if (source.harness === "codex") {
    return parts.length === 1 && projectDir === undefined && (!codexName(source.streamId, dialect) || same(source.streamId));
  }
  if (source.streamId.split(separator)[0] === "projects" && !same(source.streamId)) return false;
  if (projectDir === undefined) return true;
  const [projects, project] = parts;
  return projects === "projects" && !!project && matchesRecordedPath(dialect.join(root, projects, project), projectDir, true);
}

function validProofs(end: number, digest: unknown, checked: unknown): boolean {
  const isDigest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  if (digest !== undefined && !isDigest(digest)) return false;
  if (checked === undefined) return true;
  return isRecord(checked) && isCount(checked.offset) && checked.offset <= end && isDigest(checked.prefixDigest)
    && (checked.offset !== end || digest === undefined || checked.prefixDigest === digest);
}

function validObservation(value: unknown, source: StreamKey, acceptedOffset: number, known?: SourceLocation): value is SourceObservation {
  if (!isRecord(value) || !isCount(value.observedEnd) || value.observedEnd < acceptedOffset || !isRecord(value.location)) return false;
  if (!validProofs(value.observedEnd, value.observedPrefixDigest, value.checkedPrefix)) return false;
  const { root, path, cwd, projectDir, currentFileCwd } = value.location;
  if (typeof root !== "string" || !isIdentifier(path) || !validLocation(source, root, path, projectDir)) return false;
  if (known && (known.path !== path || (source.installationId === undefined && known.root !== root))) return false;
  if (currentFileCwd !== undefined && (source.harness !== "claude" || !recordedPathDialect(currentFileCwd))) return false;
  return cwd === undefined || !!recordedPathDialect(cwd);
}

function observedLocation(previous: SourceLocation | undefined, current: SourceLocation | undefined, sameGeneration = true): SourceLocation | undefined {
  if (!current) return previous;
  const known = sameGeneration && previous?.root === current.root && previous.path === current.path ? previous : undefined;
  return definedFields({ root: current.root, path: current.path, cwd: current.cwd ?? known?.cwd,
    projectDir: current.projectDir ?? known?.projectDir, currentFileCwd: current.currentFileCwd });
}

function knownCompleteEnd(checkpoint: Checkpoint): number {
  const fork = checkpoint.codexFork?.inheritedThrough;
  return Math.max(checkpoint.offset, checkpoint.replayThrough?.offset ?? 0, fork?.prefixDigest ? fork.offset : 0);
}

function consistentProof(checkpoint: Checkpoint, observation: SourceObservation): boolean {
  const { offset, prefixDigest } = checkpoint;
  if (!prefixDigest) return true;
  if (observation.observedEnd === offset && observation.observedPrefixDigest && observation.observedPrefixDigest !== prefixDigest) return false;
  const checked = observation.checkedPrefix;
  return checked?.offset !== offset || checked.prefixDigest === prefixDigest;
}

function completeExtent(checkpoint: Checkpoint, observation?: SourceObservation, current?: PresenceState) {
  const observedEnd = Math.max(knownCompleteEnd(checkpoint), observation?.observedEnd ?? 0, current?.observedEnd ?? 0);
  const bound = [checkpoint.replayThrough, checkpoint.codexFork?.inheritedThrough].find(p => p?.offset === observedEnd && p.prefixDigest);
  const freshDigest = observation?.observedEnd === observedEnd ? observation.observedPrefixDigest : undefined;
  const savedDigest = current?.observedEnd === observedEnd ? current.observedPrefixDigest : undefined;
  return { observedEnd, observedPrefixDigest: freshDigest ?? savedDigest ?? bound?.prefixDigest };
}

function outstandingExtent(batch: Batch, original?: ObservedExtent, outstanding?: ObservedExtent): ObservedExtent | undefined {
  if (!original?.prefixDigest) return outstanding;
  const { checkpoint } = batch;
  const checked = batch.sourceObservation?.checkedPrefix;
  const digest = checked?.offset === original.offset ? checked.prefixDigest : checkpoint.offset === original.offset ? checkpoint.prefixDigest : undefined;
  if (digest === original.prefixDigest && checkpoint.offset >= original.offset) return;
  return outstanding ?? (digest !== undefined && digest !== original.prefixDigest ? original : undefined);
}

function recordLoss(previous: PresenceState, update: PresenceWrite, end: ObservedExtent, accepted: number) {
  const old = previous.unrecovered;
  const lost = update.presence === "missing" || update.observedEnd < previous.observedEnd;
  if (!lost || end.offset <= accepted || (old && end.offset <= old.offset)) return { unrecovered: old, earlierGap: previous.earlierGap };
  const checked = update.checkedPrefix;
  // The longer capture can account for a previous loss only when it includes its original bytes.
  const includesOld = !!old?.prefixDigest && checked?.offset === old.offset && checked.prefixDigest === old.prefixDigest;
  return { unrecovered: end, earlierGap: previous.earlierGap || (!!old && !includesOld) };
}

function legacyCodexEvidence(batch: Batch, current?: PresenceState): Pick<PresenceState, "codexIdentityStatus" | "otherCodexEvidence"> {
  if (batch.checkpoint.evidenceVersion) return {};
  const recorded = [batch.usage, batch.usageWindows, batch.usageAnchors, batch.codexCallClaims, batch.usageDiagnostics, batch.codexCallAliases];
  const other = batch.source.harness === "codex" && (current?.otherCodexEvidence || recorded.some(items => items?.length)
    || batch.hasGap || batch.checkpoint.codexFork || Object.keys(batch.metadata ?? {}).length);
  return { ...(current?.codexIdentityStatus && { codexIdentityStatus: current.codexIdentityStatus }), ...(other && { otherCodexEvidence: true }) };
}

function earlierHistory(prior: PresenceState | undefined, previous: Checkpoint | undefined, reset: boolean) {
  const earlierGap = prior?.earlierGap === true || (reset && !!prior?.unrecovered && !prior.unrecovered.prefixDigest);
  const unverified = prior?.unverifiedEarlierHistory || (reset && prior?.codexIdentityStatus !== "repaired"
    && previous && legacyScannerLine(previous) !== undefined);
  return { earlierGap, ...(unverified && { unverifiedEarlierHistory: true as const }) };
}

/** Keep each acknowledged source's presence and loss evidence with its checkpoint in the same transaction. */
export class StoredSource {
  private constructor(readonly source: StreamKey, readonly checkpoint: Checkpoint, readonly generation: number,
    private readonly state: PresenceState) {}

  static accept(previous: StoredSource | undefined, batch: Batch, generation: number): StoredSource | null {
    const { source, checkpoint, sourceObservation } = batch;
    const prior = previous?.state;
    const known = prior?.location ?? (source.installationId === undefined ? legacyScannerLocation(source.harness, source.streamId) : undefined);
    if (sourceObservation !== undefined && (!validObservation(sourceObservation, source, knownCompleteEnd(checkpoint), known)
      || !consistentProof(checkpoint, sourceObservation))) return null;
    const reset = batch.resetFrom !== undefined;
    const current = reset ? undefined : prior;
    const location = observedLocation(known, sourceObservation?.location, !reset);
    const present = sourceObservation !== undefined || reset || checkpoint.offset > batch.expectedOffset;
    const state: PresenceState = {
      location, presence: present ? "present" : prior?.presence ?? "present",
      unrecovered: outstandingExtent(batch, previous?.observedThrough, prior?.unrecovered),
      ...completeExtent(checkpoint, sourceObservation, current),
      ...legacyCodexEvidence(batch, current),
      ...earlierHistory(prior, previous?.checkpoint, reset),
    };
    const { harness, sessionId, streamId, installationId } = source;
    const key = previous?.source ?? definedFields({ harness, sessionId, streamId, installationId });
    return new StoredSource(key, checkpoint, generation, state);
  }

  sharesEvidence(other: StoredSource): boolean {
    return this.generation === other.generation && !this.hasGap && !other.hasGap && !!this.checkpoint.prefixDigest
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
      (this.state.presence === "missing" && !this.repairedIdentity && legacyScannerLine(this.checkpoint) !== undefined);
  }

  get observedThrough(): ObservedExtent | undefined {
    const { observedEnd, observedPrefixDigest, unrecovered } = this.state;
    return unrecovered ?? (observedEnd > this.checkpoint.offset ? definedFields({ offset: observedEnd, prefixDigest: observedPrefixDigest }) : undefined);
  }

  record(update: PresenceWrite, identity?: CodexIdentityStatus): StoredSource | null {
    const accepted = this.checkpoint.offset;
    const previous = this.state;
    if ((update.presence !== "present" && update.presence !== "missing")
      || !validObservation(update, this.source, accepted, previous.location)) return null;
    let location = previous.location;
    if (update.presence === "missing") {
      if (location?.root !== update.location.root || location.path !== update.location.path) return null;
    } else location = observedLocation(location, update.location);
    const observedEnd = Math.max(previous.observedEnd, update.observedEnd);
    const observedPrefixDigest = update.observedEnd === observedEnd && update.observedPrefixDigest ? update.observedPrefixDigest :
      previous.observedEnd === observedEnd ? previous.observedPrefixDigest : undefined;
    const loss = recordLoss(previous, update, definedFields({ offset: observedEnd, prefixDigest: observedPrefixDigest }), accepted);
    const state = { ...previous, ...loss, presence: update.presence, location, observedEnd, observedPrefixDigest,
      ...(identity && { codexIdentityStatus: identity }) };
    return isDeepStrictEqual(state, previous) ? this : new StoredSource(this.source, this.checkpoint, this.generation, state);
  }

  selected(scope: SourceScope | undefined, version: number): AcknowledgedSource | undefined {
    const { location, observedEnd, presence } = this.state;
    if (!location || (scope && !matchesSourceScope(scope, this.source, location))) return;
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
