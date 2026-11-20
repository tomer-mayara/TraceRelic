import { mock } from "node:test";
import { StorageUnavailableError, type AcknowledgedSource, type Batch, type Checkpoint, type SessionKey,
  type SourceScope, type StreamKey } from "@tracerelic/collector/storage";
import type { CollectorWrite, CollectorTransaction, PersistedSession } from "../../src/storage/collector-database.ts";
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

  readonly readSession = mock.fn(async (_workspace: string, _key: SessionKey) => session);
  readonly readCheckpoint = mock.fn(async (_workspace: string, _source: StreamKey) => ({ version: 1, checkpoint: batch.checkpoint }));
  readonly listSources = mock.fn(async (_workspace: string, _scope: SourceScope) => [storedSource]);

  async write<T>(workspace: string, action: (tx: CollectorTransaction) => Promise<T>): Promise<T> {
    let pending: SavedWrite | undefined;
    const result = await action({
      entriesAfter: async (position, limit?: number) => {
        this.cursors.push(position);
        return this.saved.filter(row => row.workspace === workspace && BigInt(row.position) > BigInt(position)).slice(0, limit);
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
