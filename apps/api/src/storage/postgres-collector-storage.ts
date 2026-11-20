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

  private async apply(write: JournalWrite, changed?: SessionRevision[], lc17Journal = false): Promise<CommitResult> {
    if (write.kind === "alias") {
      const { source, target, expectedVersion } = write.value;
      return await this.storage.mergeSourceAlias(source, target, expectedVersion) ? "committed" : "conflict";
    }
    return write.kind === "batch" ? this.storage.commit(write.value, changed, lc17Journal) : this.storage.recordPresence(write.value, changed, lc17Journal);
  }

  private async catchUp(tx: CollectorTransaction): Promise<void> {
    const pageSize = 64;
    const unversioned = new Map<string, SessionKey>();
    for (;;) {
      const entries = await tx.entriesAfter(this.position, pageSize);
      for (const { write, revisions, position } of entries) {
        const source = write.value.source;
        const changed: SessionRevision[] = [];
        // A journal item's source version is an accepted fact. Old entries did not record which peers also advanced.
        if (revisions) this.storage.restoreRevisions(revisions.map(row => ({ ...row, version: row.version - 1 })));
        this.storage.restoreRevisions([{ ...source, version: write.value.expectedVersion }]);
        const peer = write.kind === "presence" && write.value.codexIdentity;
        if (peer && peer.status === "verified") this.storage.restoreRevisions([{ harness: source.harness, sessionId: peer.peerSessionId, version: peer.expectedPeerVersion }]);
        const lc17 = !revisions && write.kind !== "alias"
          && !(write.kind === "batch" ? write.value.checkpoint.evidenceVersion : write.value.codexIdentity);
        if (await this.apply(write, changed, lc17) !== "committed") throw new Error("Cannot replay accepted collector write");
        if (revisions) {
          this.storage.restoreRevisions(changed.map(row => ({ ...row, version: row.version - 1 })));
          this.storage.restoreRevisions(revisions);
        } else {
          for (const key of [source, ...changed]) unversioned.set(JSON.stringify([key.harness, key.sessionId]), key);
        }
        this.position = position;
      }
      if (entries.length < pageSize) break;
    }
    // LC-17 materialized every actual session version in the same transaction as its raw journal entry.
    const keys = [...unversioned.values()];
    for (let index = 0; index < keys.length; index += pageSize) {
      this.storage.restoreRevisions(await tx.storedVersions(keys.slice(index, index + pageSize)));
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
