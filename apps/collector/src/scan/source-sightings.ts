import type { TranscriptSource } from "../transcript/index.ts";
import { matchesSourceScope, type Batch, type CheckpointSnapshot, type CollectorStorage, type MissingSource,
  type ObservedExtent, type SourceObservation, type SourceScope, type StreamKey } from "../storage/collector-storage.ts";
import { captureProof, readStorage } from "./scan-recovery.ts";
import type { LocatedSource } from "./scan-provider.ts";

export function sourceId(source: StreamKey): string {
  return JSON.stringify([source.harness, source.sessionId, source.streamId, source.installationId]);
}

/** Keep the last confirmed byte separate from an upload whose reply is unknown. */
export class SourceSighting {
  confirmed?: CheckpointSnapshot;
  /** Version at which this capture matched the accepted prefix. */
  verified?: { version: number; extent: ObservedExtent; checkedPrefix?: SourceObservation["checkedPrefix"] };
  rejected = false;

  constructor(readonly source: StreamKey, readonly observation: SourceObservation, private readonly storage: CollectorStorage) {}

  verifyAt(version: number, reset = false): void {
    const extent = { offset: this.observation.observedEnd, prefixDigest: this.observation.observedPrefixDigest };
    if (reset || !this.verified || extent.offset >= this.verified.extent.offset) {
      this.verified = { version, extent, checkedPrefix: this.observation.checkedPrefix };
    }
  }

  async readCheckpoint() {
    this.confirmed = await this.storage.readCheckpoint(this.source);
    return this.confirmed;
  }

  async commit(batch: Batch) {
    const previous = this.confirmed;
    this.confirmed = undefined;
    const result = await this.storage.commit({ ...batch, sourceObservation: this.observation });
    if (result === "committed") {
      const version = batch.expectedVersion + 1;
      this.verifyAt(version, !!batch.resetFrom);
      this.confirmed = { version, checkpoint: batch.checkpoint };
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

  async capture(scope: SourceScope, transcript: TranscriptSource<unknown>, located: LocatedSource, observedEnd: number): Promise<SourceSighting> {
    const { harness, installationId } = scope;
    const { sessionId } = transcript;
    const { location, rootStreamId } = located;
    const streamId = installationId ? location.path : rootStreamId;
    const key = { harness, sessionId, streamId, ...(installationId && { installationId }) };
    const observation = { location, observedEnd };
    const local = this.remember(key, observation);
    const resolve = this.storage.resolveSource?.bind(this.storage);
    if (!resolve) return local;
    const source = await readStorage(key, () => resolve(key, location, async checkpoint => !!await captureProof(transcript, checkpoint)));
    if (sourceId(source) === sourceId(key)) return local;
    this.forget(local);
    return this.remember(source, observation);
  }

  private remember(source: StreamKey, observation: SourceObservation) {
    const sighting = new SourceSighting(source, observation, this.storage);
    const id = sourceId(source), previous = this.pending.get(id);
    sighting.confirmed = previous?.confirmed;
    sighting.verified = previous?.verified;
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
