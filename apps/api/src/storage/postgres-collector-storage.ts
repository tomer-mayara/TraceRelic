import { InMemoryCollectorStorage, type SessionRevision } from "@tracerelic/collector/memory-storage";
import { legacyScannerLocation, type Batch, type CollectorStorage, type CommitResult, type PresenceWrite, type SessionKey, type SourceScope, type StreamKey } from "@tracerelic/collector/storage";
import { SessionVersionConflict, type CollectorTransaction, type JournalWrite,
  type PostgresCollectorDatabase } from "./collector-database.ts";
import { projectSession, type SessionRecords } from "./collector-projection.ts";

/** Retain the evidence used to validate this workspace's next write, including ownership across sessions. */
class WorkspaceWriter {
  private readonly storage = new InMemoryCollectorStorage();
  private position = "0";
  private recent = new Map<string, { version: number; records: SessionRecords }>();

  private async apply(write: JournalWrite, changed?: SessionRevision[]): Promise<CommitResult> {
    if (write.kind === "alias") {
      const { source, target, expectedVersion } = write.value;
      return await this.storage.mergeSourceAlias(source, target, expectedVersion) ? "committed" : "conflict";
    }
    return write.kind === "batch" ? this.storage.commit(write.value, changed) : this.storage.recordPresence(write.value, changed);
  }

  private async catchUp(tx: CollectorTransaction): Promise<void> {
    const pageSize = 64;
    for (;;) {
      const entries = await tx.entriesAfter(this.position, pageSize);
      for (const entry of entries) {
        if (await this.apply(entry.write) !== "committed") throw new Error("Cannot replay accepted collector write");
        this.position = entry.position;
      }
      if (entries.length < pageSize) return;
    }
  }

  async accept(tx: CollectorTransaction, write: JournalWrite): Promise<CommitResult> {
    await this.catchUp(tx);
    const canonical = await this.storage.canonicalSource(write.value.source);
    if (write.kind === "alias") {
      if (canonical !== undefined) return canonical === write.value.target ? "committed" : "conflict";
      const result = await this.apply(write);
      if (result === "committed") {
        const view = await this.storage.readSession(write.value.source);
        if (!view) throw new Error("Missing collector alias session");
        this.position = await tx.saveAlias(write, projectSession(write.value.expectedVersion, view).summary);
      }
      return result;
    }
    if (canonical !== undefined) write.value.source = { ...write.value.source, streamId: canonical };
    const changed: SessionRevision[] = [];
    const outcome = await this.apply(write, changed);
    if (outcome !== "committed" || !changed.length) return outcome;
    const source = write.value.source;
    const recent: typeof this.recent = new Map();
    const recordsChanged = write.kind === "batch" || "codexIdentity" in write.value;
    const sessions = await Promise.all(changed.map(async revision => {
      const view = await this.storage.readSession(revision);
      if (!view) throw new Error("Changed collector session is missing");
      const key = JSON.stringify([revision.harness, revision.sessionId]);
      const prior = this.recent.get(key);
      const cached = prior?.version === revision.version - 1 ? prior.records : undefined;
      // Other API writers and older reducer versions may have left a different materialized view.
      const before = recordsChanged ? cached ?? (revision.version === 1 ? { messages: [], usage: [] } : await tx.recordsFor(revision)) : undefined;
      const confirmed = recordsChanged ? view : cached;
      if (confirmed) recent.set(key, { version: revision.version, records: confirmed });
      return projectSession(revision.version, view, before);
    }));
    const { checkpoint } = await this.storage.readCheckpoint(source);
    if (!checkpoint) throw new Error("Accepted collector source has no checkpoint");
    this.position = await tx.save(write, sessions, checkpoint, this.storage.readAcknowledgedSource(source));
    this.recent = recent;
    return outcome;
  }
}

type CollectorDatabase = Pick<PostgresCollectorDatabase, "canonical" | "readSession" | "readCheckpoint" | "listSources" | "write">;

export class PostgresCollectorStorage implements CollectorStorage {
  private confirmed?: WorkspaceWriter;
  private pending: Promise<CommitResult | void> = Promise.resolve();

  constructor(private readonly database: CollectorDatabase, private readonly workspaceId: string) {}

  readSession(key: SessionKey) { return this.database.readSession(this.workspaceId, key); }
  async canonicalSource(source: StreamKey) {
    if (legacyScannerLocation(source.harness, source.streamId)) return this.database.canonical(this.workspaceId, source);
  }
  async mergeSourceAlias(source: StreamKey, target: string, expectedVersion: number) {
    return await this.enqueue({ kind: "alias", value: { source, target, expectedVersion } }) === "committed";
  }
  async readCheckpoint(source: StreamKey) {
    const target = await this.canonicalSource(source);
    return this.database.readCheckpoint(this.workspaceId, target === undefined ? source : { ...source, streamId: target });
  }
  listSources(scope: SourceScope) { return this.database.listSources(this.workspaceId, scope); }
  commit(batch: Batch) { return this.enqueue({ kind: "batch", value: batch }); }
  recordPresence(update: PresenceWrite) { return this.enqueue({ kind: "presence", value: update }); }

  private async enqueue(input: JournalWrite): Promise<CommitResult> {
    const write = structuredClone(input);
    const result = this.pending.then(async () => {
      const writer = this.confirmed ?? new WorkspaceWriter();
      // A lost database reply can conceal a commit. Rebuild from the journal after any failed transaction.
      this.confirmed = undefined;
      const outcome = await this.database.write(this.workspaceId, tx => writer.accept(tx, write));
      this.confirmed = writer;
      return outcome;
    }).catch((error: unknown) => {
      if (error instanceof SessionVersionConflict) return "conflict" as const;
      throw error;
    });
    this.pending = result.catch(() => {});
    return result;
  }
}
