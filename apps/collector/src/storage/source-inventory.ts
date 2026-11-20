import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  matchesSourceScope, type AcknowledgedSource, type Batch, type Checkpoint, type MissingSource, type PresenceWrite,
  type SourceLocation, type SourceObservation, type SourcePresence, type SourceScope, type StreamKey,
} from "./collector-storage.ts";
import { definedFields, isCount, isIdentifier, isRecord } from "./usage-validation.ts";

interface PresenceState {
  location?: SourceLocation;
  presence: SourcePresence;
  observedEnd: number;
  /** Complete bytes confirmed lost from the current generation. A verified append can recover them. */
  missingThrough: number;
  earlierGap: boolean;
}

function absolute(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && isAbsolute(value);
}

function codexName(path: string): boolean {
  return path === basename(path) && /^rollout-.*\.jsonl$/.test(path) && !path.includes("\0");
}

function matchesNativePath(source: StreamKey, root: string, path: string, projectDir: unknown): boolean {
  if (source.harness === "codex") {
    return basename(path) === path && projectDir === undefined && (!codexName(source.streamId) || path === source.streamId);
  }
  if (source.streamId.startsWith("projects" + sep) && source.streamId !== path) return false;
  if (projectDir === undefined) return true;
  const [projects, project] = path.split(sep);
  return absolute(projectDir) && projects === "projects" && !!project && join(root, projects, project) === projectDir;
}

function validObservation(value: unknown, source: StreamKey, acceptedOffset: number, known?: SourceLocation): value is SourceObservation {
  if (!isRecord(value) || !isCount(value.observedEnd) || value.observedEnd < acceptedOffset || !isRecord(value.location)) return false;
  const { root, path, cwd, projectDir, currentFileCwd } = value.location;
  if (!absolute(root) || !isIdentifier(path) || path.includes("\0") || isAbsolute(path)
    || path.split(sep).some(part => !part || part === ".." || part === ".")) return false;
  if (known && (known.path !== path || (source.installationId === undefined && known.root !== root))) return false;
  if (currentFileCwd !== undefined && (source.harness !== "claude" || !absolute(currentFileCwd))) return false;
  return (cwd === undefined || absolute(cwd)) && matchesNativePath(source, root, path, projectDir);
}

/** With no installation ID, the older scanner embedded the configured root in its stream key. */
function legacyLocation({ harness, streamId, installationId }: StreamKey): SourceLocation | undefined {
  if (installationId !== undefined) return;
  if (harness === "codex") {
    try {
      const pair: unknown = JSON.parse(streamId);
      if (!Array.isArray(pair) || pair.length !== 2) return;
      const [root, path] = pair;
      if (absolute(root) && typeof path === "string" && codexName(path)) return { root, path };
    } catch { /* Other adapters can use opaque stream IDs. */ }
    return;
  }
  if (!absolute(streamId) || !/\.jsonl(?:\.superseded-\d.*)?$/.test(streamId)) return;
  const directory = dirname(streamId);
  const candidates = [directory];
  if (basename(directory) === "subagents" && basename(streamId).startsWith("agent-")) candidates.push(dirname(dirname(directory)));
  const projects = candidates.filter(path => basename(dirname(path)) === "projects");
  if (projects.length !== 1) return;
  const [projectDir] = projects;
  const root = dirname(dirname(projectDir));
  return { root, path: relative(root, streamId), projectDir };
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

/** Keep each acknowledged source's presence and loss evidence with its checkpoint in the same transaction. */
export class StoredSource {
  private constructor(readonly source: StreamKey, readonly checkpoint: Checkpoint, readonly generation: number,
    private readonly state: PresenceState) {}

  static accept(previous: StoredSource | undefined, batch: Batch, generation: number): StoredSource | null {
    const { source, checkpoint, sourceObservation } = batch;
    const prior = previous?.state;
    const known = prior?.location ?? legacyLocation(source);
    const completeEnd = knownCompleteEnd(checkpoint);
    if (sourceObservation !== undefined && !validObservation(sourceObservation, source, completeEnd, known)) return null;
    const reset = batch.resetFrom !== undefined;
    const current = reset ? undefined : prior;
    const location = observedLocation(known, sourceObservation?.location, !reset);
    const present = sourceObservation !== undefined || reset || checkpoint.offset > batch.expectedOffset;
    const state: PresenceState = {
      location, presence: present ? "present" : prior?.presence ?? "present",
      observedEnd: Math.max(completeEnd, sourceObservation?.observedEnd ?? 0, current?.observedEnd ?? 0),
      missingThrough: current?.missingThrough ?? 0,
      // A replacement reaching the same byte cannot establish that it recovered the missing original suffix.
      earlierGap: prior?.earlierGap === true || (reset && previous?.hasGap === true),
    };
    const { harness, sessionId, streamId, installationId } = source;
    const key = previous?.source ?? definedFields({ harness, sessionId, streamId, installationId });
    return new StoredSource(key, checkpoint, generation, state);
  }

  get hasGap(): boolean {
    return this.state.earlierGap || this.state.missingThrough > this.checkpoint.offset;
  }

  record(update: PresenceWrite): StoredSource | null {
    const accepted = this.checkpoint.offset;
    const previous = this.state;
    if ((update.presence !== "present" && update.presence !== "missing")
      || !validObservation(update, this.source, accepted, previous.location)) return null;
    let location = previous.location;
    if (update.presence === "missing") {
      if (location?.root !== update.location.root || location.path !== update.location.path) return null;
    } else location = observedLocation(location, update.location);
    const observedEnd = Math.max(previous.observedEnd, update.observedEnd);
    const missingThrough = update.presence === "missing" && observedEnd > accepted ? observedEnd : previous.missingThrough;
    const state = { ...previous, presence: update.presence, location, observedEnd, missingThrough };
    return isDeepStrictEqual(state, previous) ? this : new StoredSource(this.source, this.checkpoint, this.generation, state);
  }

  selected(scope: SourceScope | undefined, version: number): AcknowledgedSource | undefined {
    const { location, observedEnd, presence } = this.state;
    if (!location || (scope && !matchesSourceScope(scope, this.source, location))) return;
    return { source: this.source, location, observedEnd, presence, version, acceptedOffset: this.checkpoint.offset };
  }

  missing(): MissingSource | undefined {
    if (this.state.presence === "missing") return { status: "missing", source: this.source,
      acceptedOffset: this.checkpoint.offset, observedEnd: this.state.observedEnd };
  }
}
