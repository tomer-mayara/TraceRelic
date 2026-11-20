import { InMemoryCollectorStorage, type SessionRevision } from "@tracerelic/collector/memory-storage";
import type { Batch, CollectorStorage, CommitResult, PresenceWrite, SessionKey, SourceScope, StreamKey } from "@tracerelic/collector/storage";
import { SessionVersionConflict, type CollectorTransaction, type CollectorWrite, type PersistedSession,
  type PostgresCollectorDatabase } from "./collector-database.ts";

/** Retain the evidence used to validate this workspace's next write, including ownership across sessions. */
class WorkspaceWriter {
  private readonly storage = new InMemoryCollectorStorage();
  private position = "0";

  private apply(write: CollectorWrite, changed?: SessionRevision[]): Promise<CommitResult> {
    return write.kind === "batch" ? this.storage.commit(write.value, changed) : this.storage.recordPresence(write.value, changed);
  }

  private async session(revision: SessionRevision): Promise<PersistedSession> {
    const view = await this.storage.readSession(revision);
    if (!view) throw new Error("Changed collector session is missing");
    return { version: revision.version, view };
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

  async accept(tx: CollectorTransaction, write: CollectorWrite): Promise<CommitResult> {
    await this.catchUp(tx);
    const changed: SessionRevision[] = [];
    const outcome = await this.apply(write, changed);
    if (outcome !== "committed" || !changed.length) return outcome;
    const source = write.value.source;
    const sessions = await Promise.all(changed.map(revision => this.session(revision)));
    const { checkpoint } = await this.storage.readCheckpoint(source);
    if (!checkpoint) throw new Error("Accepted collector source has no checkpoint");
    this.position = await tx.save(write, sessions, checkpoint, this.storage.readAcknowledgedSource(source));
    return outcome;
  }
}

type CollectorDatabase = Pick<PostgresCollectorDatabase, "readSession" | "readCheckpoint" | "listSources" | "write">;

export class PostgresCollectorStorage implements CollectorStorage {
  private confirmed?: WorkspaceWriter;
  private pending: Promise<CommitResult | void> = Promise.resolve();

  constructor(private readonly database: CollectorDatabase, private readonly workspaceId: string) {}

  readSession(key: SessionKey) { return this.database.readSession(this.workspaceId, key); }
  readCheckpoint(source: StreamKey) { return this.database.readCheckpoint(this.workspaceId, source); }
  listSources(scope: SourceScope) { return this.database.listSources(this.workspaceId, scope); }
  commit(batch: Batch) { return this.enqueue({ kind: "batch", value: batch }); }
  recordPresence(update: PresenceWrite) { return this.enqueue({ kind: "presence", value: update }); }

  private async enqueue(input: CollectorWrite): Promise<CommitResult> {
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
