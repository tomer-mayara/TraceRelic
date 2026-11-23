import type {
  AcknowledgedSource, Batch, CheckpointSnapshot, CollectorStorage, CommitResult, PresenceWrite, SessionKey, SessionView, SourceScope, StreamKey,
} from "@tracerelic/collector/storage";

/** The answers of the storage mock. */
export interface StorageScript {
  /** The acknowledged sources. listSources gives the rows under the root of the scope. */
  readonly acknowledged?: readonly AcknowledgedSource[];
  /** The stored sessions. A stream of a stored session has version 1 and no checkpoint. */
  readonly sessions?: readonly SessionView[];
}

/**
 * A storage mock for the unit tests of the scanner. It accepts each write and gives the scripted answers.
 * It adds one line to the journal for each call, such as "commit codex/one" or "listSources /root".
 */
export class RecordingCollectorStorage implements CollectorStorage {
  readonly batches: Batch[] = [];
  readonly presence: PresenceWrite[] = [];

  constructor(private readonly script: StorageScript = {}, readonly journal: string[] = []) {}

  async listSources(scope: SourceScope): Promise<AcknowledgedSource[]> {
    this.journal.push(`listSources ${scope.root}`);
    return (this.script.acknowledged ?? []).filter(row => row.location.root === scope.root);
  }

  async recordPresence(update: PresenceWrite): Promise<CommitResult> {
    this.record("recordPresence", update.source);
    this.presence.push(update);
    return "committed";
  }

  async readCheckpoint(source: StreamKey): Promise<CheckpointSnapshot> {
    this.record("readCheckpoint", source);
    return { version: this.stored(source) ? 1 : 0, checkpoint: null };
  }

  async commit(batch: Batch): Promise<CommitResult> {
    this.record("commit", batch.source);
    this.batches.push(batch);
    return "committed";
  }

  async readSession(key: SessionKey): Promise<SessionView | null> {
    this.record("readSession", key);
    return this.stored(key) ?? null;
  }

  private stored({ harness, sessionId }: SessionKey): SessionView | undefined {
    return this.script.sessions?.find(({ key }) => key.harness === harness && key.sessionId === sessionId);
  }

  private record(call: string, { harness, sessionId }: SessionKey): void {
    this.journal.push(`${call} ${harness}/${sessionId}`);
  }
}
