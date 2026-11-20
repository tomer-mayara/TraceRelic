import { mock } from "node:test";
import { StorageUnavailableError, type AcknowledgedSource, type Batch, type Checkpoint, type Message, type Usage, type SessionKey,
  type SourceScope, type StreamKey } from "@tracerelic/collector/storage";
import type { CollectorWrite, CollectorTransaction } from "../../src/storage/collector-database.ts";
import type { PersistedSession, RecordChanges } from "../../src/storage/collector-projection.ts";
import { batch, session, storedSource } from "./collector-wire-payloads.ts";

interface SavedWrite {
  workspace: string;
  position: string;
  write: CollectorWrite;
  sessions: readonly PersistedSession[];
  checkpoint: Checkpoint;
  inventory: AcknowledgedSource | null;
}

export class CollectorTransactionFixture {
  readonly saved: SavedWrite[] = [];
  readonly cursors: string[] = [];
  failure?: "rollback" | "lost-reply";
  beforeCommit?: () => Promise<void>;

  readonly canonical = mock.fn(async (_workspace: string, _key: StreamKey) => undefined);
  readonly readSession = mock.fn(async (_workspace: string, _key: SessionKey) => session);
  readonly readCheckpoint = mock.fn(async (_workspace: string, _source: StreamKey) => ({ version: 1, checkpoint: batch.checkpoint }));
  readonly listSources = mock.fn(async (_workspace: string, _scope: SourceScope) => [storedSource]);

  private recordsFor(workspace: string, key: SessionKey) {
    const messages = new Map<string, { ordinal: number; record: Message }>();
    const usage = new Map<string, { ordinal: number; record: Usage }>();
    function apply<T extends { id: string }>(target: Map<string, { ordinal: number; record: T }>, changes: RecordChanges<T>) {
      for (const row of changes.upserts) target.set(row.record.id, row);
      for (const id of changes.removed) target.delete(id);
    }
    for (const row of this.saved) {
      if (row.workspace !== workspace) continue;
      for (const session of row.sessions) {
        if (session.summary.key.harness !== key.harness || session.summary.key.sessionId !== key.sessionId) continue;
        apply(messages, session.messages);
        apply(usage, session.usage);
      }
    }
    const ordered = <T>(rows: Map<string, { ordinal: number; record: T }>) =>
      [...rows.values()].sort((a,b) => a.ordinal-b.ordinal).map(row => row.record);
    return { messages: ordered(messages), usage: ordered(usage) };
  }

  async write<T>(workspace: string, action: (tx: CollectorTransaction) => Promise<T>): Promise<T> {
    let pending: SavedWrite | undefined;
    const result = await action({
      saveAlias: async () => { throw new Error("Unexpected alias write"); },
      recordsFor: async key => this.recordsFor(workspace, key),
      storedVersions: async () => { throw new Error("Expected a journal with revision receipts"); },
      entriesAfter: async (position, limit?: number) => {
        this.cursors.push(position);
        return this.saved.filter(row => row.workspace === workspace && BigInt(row.position) > BigInt(position)).slice(0, limit)
          .map(row => ({ ...row, revisions: row.sessions.map(({ summary, version }) => ({ ...summary.key, version })) }));
      },
      save: async (write, sessions, checkpoint, inventory) => {
        const position = String(this.saved.length + 1);
        pending = structuredClone({ workspace, position, write, sessions, checkpoint, inventory });
        return position;
      },
    });
    if (pending) {
      const failure = this.failure;
      this.failure = undefined;
      await this.beforeCommit?.();
      if (failure !== "rollback") this.saved.push(pending);
      if (failure) throw new StorageUnavailableError("Disconnected during commit");
    }
    return result;
  }
}

export function revision(expectedVersion: number): Batch {
  const offset = 100 * (expectedVersion + 1);
  return {
    ...batch, expectedVersion, expectedOffset: offset - 100,
    checkpoint: { ...batch.checkpoint, offset }, sourceObservation: { ...batch.sourceObservation, observedEnd: offset },
    messages: [], usage: [{ ...batch.usage[0], revision: expectedVersion + 1, inputTokens: 120 + expectedVersion }],
  };
}
