import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import type { Batch, CollectorStorage, PresenceWrite, SessionKey, SourceScope, StreamKey } from "@tracerelic/collector/storage";
import { RewriteScanFixture } from "./rewrite-scan-fixture.ts";

export type DropMoment = "before storage writes" | "after storage writes";

/** A test adapter can drop the request or the reply at its own transport boundary. */
export interface InterruptibleConnection extends CollectorStorage {
  readonly writes: number;
  readonly checkedWhileOffline: boolean;
  dropNextWrite(moment: DropMoment, stayOffline?: boolean): void;
  reconnect(): void;
}

export class DroppedConnection implements InterruptibleConnection {
  private drop?: { moment: DropMoment; stayOffline: boolean };
  private offline = false;
  writes = 0;
  checkedWhileOffline = false;

  constructor(private readonly storage: CollectorStorage) {}

  dropNextWrite(moment: DropMoment, stayOffline = true) {
    this.drop = { moment, stayOffline };
  }

  reconnect() {
    this.offline = false;
  }

  private fail(): never {
    throw Object.assign(new Error("private transport detail"), { code: "ECONNRESET" });
  }

  async readCheckpoint(key: StreamKey) {
    if (this.offline) {
      this.checkedWhileOffline = true;
      this.fail();
    }
    return this.storage.readCheckpoint(key);
  }

  async readSession(key: SessionKey) {
    if (this.offline) this.fail();
    return this.storage.readSession(key);
  }

  async listSources(scope: SourceScope) {
    if (this.offline) this.fail();
    return this.storage.listSources(scope);
  }

  async recordPresence(update: PresenceWrite) {
    if (this.offline) this.fail();
    return this.storage.recordPresence(update);
  }

  async commit(batch: Batch) {
    this.writes++;
    if (this.offline) this.fail();
    const drop = this.drop;
    if (!drop) return this.storage.commit(batch);
    this.drop = undefined;
    if (drop.moment === "after storage writes") await this.storage.commit(batch);
    this.offline = drop.stayOffline;
    this.fail();
  }
}

export class LostConnectionFixture {
  firstEnd = 0;
  secondEnd = 0;
  private firstId = "";
  private firstTokens = 0;
  private secondId?: string;

  private constructor(
    readonly transcript: RewriteScanFixture, readonly storage: CollectorStorage, readonly connection: InterruptibleConnection,
  ) {}

  static async create(adapters?: { storage: CollectorStorage; connection?: InterruptibleConnection }) {
    const transcript = await RewriteScanFixture.create();
    const storage = adapters?.storage ?? transcript.storage;
    return new LostConnectionFixture(transcript, storage, adapters?.connection ?? new DroppedConnection(storage));
  }

  close() {
    return this.transcript.close();
  }

  async prepare(first: number, second: number, scan = () => this.transcript.scan(this.connection)) {
    await this.transcript.write([this.transcript.call("first", first)]);
    this.firstEnd = (await stat(this.transcript.file)).size;
    const initial = await scan();
    assert.equal(initial.observedTotalTokens, first);
    assert.equal(initial.usage.length, 1);
    this.firstId = initial.usage[0].id;
    this.firstTokens = first;
    await this.transcript.append({ ...this.transcript.call("second", second), private_note: "private transcript detail" });
    this.secondEnd = (await stat(this.transcript.file)).size;
  }

  async checkStored(calls: 1 | 2, total: number) {
    const accepted = await this.storage.readCheckpoint(this.transcript.source);
    assert.equal(accepted.checkpoint?.offset, calls === 1 ? this.firstEnd : this.secondEnd);
    assert.equal(accepted.version, calls);
    const session = await this.storage.readSession(this.transcript.source);
    assert(session);
    assert.equal(session.coverage, "reported");
    assert.equal(session.observedTotalTokens, total);
    assert.equal(session.usage.length, calls);
    assert(session.usage.every(row => row.kind === "call"));
    const ids = session.usage.map(row => row.id);
    assert.equal(new Set(ids).size, calls);
    const first = session.usage.find(row => row.id === this.firstId);
    assert(first);
    assert.equal(first.inputTokens + first.outputTokens, this.firstTokens);
    if (calls === 2) {
      const second = ids.find(id => id !== this.firstId);
      assert(second);
      if (this.secondId) assert.equal(second, this.secondId);
      this.secondId = second;
    }
    return session;
  }
}
