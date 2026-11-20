import { basename, relative } from "node:path";
import type { TranscriptSource } from "../history/index.ts";
import { matchesSourceScope, type Batch, type CheckpointSnapshot, type CollectorStorage, type MissingSource,
  type SourceObservation, type SourceScope, type StreamKey } from "../storage/collector-storage.ts";

export function sourceId(source: StreamKey): string {
  return JSON.stringify([source.harness, source.sessionId, source.streamId, source.installationId]);
}

/** Keep the last confirmed byte separate from an upload whose reply is unknown. */
export class SourceSighting {
  confirmed?: CheckpointSnapshot;
  /** Version at which this capture matched the accepted prefix. */
  verifiedVersion?: number;
  rejected = false;

  constructor(readonly source: StreamKey, readonly observation: SourceObservation, private readonly storage: CollectorStorage) {}

  async readCheckpoint() {
    this.confirmed = await this.storage.readCheckpoint(this.source);
    return this.confirmed;
  }

  async commit(batch: Batch) {
    const previous = this.confirmed;
    this.confirmed = undefined;
    const result = await this.storage.commit({ ...batch, sourceObservation: this.observation });
    if (result === "committed") {
      this.verifiedVersion = batch.expectedVersion + 1;
      this.confirmed = { version: this.verifiedVersion, checkpoint: batch.checkpoint };
    }
    if (result === "invalid") {
      this.confirmed = previous;
      this.rejected = true;
    }
    return result;
  }
}

/** Only observations with no confirmed inventory entry need to survive the next scan. */
export class SourceSightings {
  private readonly pending = new Map<string, SourceSighting>();
  private readonly unconfirmedReports = new Map<string, MissingSource>();

  constructor(readonly storage: CollectorStorage, readonly onMissing?: (report: MissingSource) => void) {}

  capture(scope: SourceScope, transcript: TranscriptSource<unknown>, observedEnd: number): SourceSighting {
    const { root, harness, installationId } = scope;
    const { sourceFile, sessionId, selectionCwd: cwd, projectDir, currentFileCwd } = transcript;
    const path = harness === "codex" ? basename(sourceFile) : relative(root, sourceFile);
    const streamId = installationId ? path : harness === "codex" ? JSON.stringify([root, path]) : sourceFile;
    const source = { harness, sessionId, streamId, ...(installationId && { installationId }) };
    const location = { root, path, ...(cwd && { cwd }), ...(projectDir && { projectDir }), ...(currentFileCwd && { currentFileCwd }) };
    const sighting = new SourceSighting(source, { location, observedEnd }, this.storage);
    const id = sourceId(source);
    sighting.confirmed = this.pending.get(id)?.confirmed;
    this.pending.set(id, sighting);
    return sighting;
  }

  forScope(scope: SourceScope): SourceSighting[] {
    return [...this.pending.values()].filter(({ source, observation }) => matchesSourceScope(scope, source, observation.location));
  }

  forget(sighting: SourceSighting): void {
    const id = sourceId(sighting.source);
    if (this.pending.get(id) === sighting) this.pending.delete(id);
  }

  rememberReply(report: MissingSource): void {
    this.unconfirmedReports.set(sourceId(report.source), report);
  }

  confirmReply(report: MissingSource): void {
    const id = sourceId(report.source);
    const attempted = this.unconfirmedReports.get(id);
    this.unconfirmedReports.delete(id);
    if (attempted?.acceptedOffset === report.acceptedOffset && attempted.observedEnd === report.observedEnd) this.onMissing?.(report);
  }

  discardReply(source: StreamKey): void {
    this.unconfirmedReports.delete(sourceId(source));
  }
}
