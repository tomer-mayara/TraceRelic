import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { InMemoryCollectorStorage } from "@tracerelic/collector/memory-storage";
import type { Batch, CollectorStorage } from "@tracerelic/collector/storage";
import { PostgresCollectorDatabase } from "#src/storage/collector-database";
import { PostgresCollectorStorage } from "#src/storage/postgres-collector-storage";
import { DisposablePostgres } from "./disposable-postgres.ts";

/** Keep the reference workspaces while replacing the connection and every PostgreSQL adapter. */
export class DurableParityFixture {
  private readonly workspaces = new Map<string, { memory: CollectorStorage; postgres: CollectorStorage }>();

  private constructor(private readonly testDatabase: DisposablePostgres, private database: PostgresCollectorDatabase) {}

  static async open(t: TestContext): Promise<DurableParityFixture> {
    const disposable = await DisposablePostgres.open();
    try {
      const fixture = new DurableParityFixture(disposable, await PostgresCollectorDatabase.open(disposable.url));
      t.after(async () => {
        try { await fixture.database.close(); } finally { await disposable.close(); }
      });
      return fixture;
    } catch (error) {
      await disposable.close();
      throw error;
    }
  }

  async reconnect(): Promise<void> {
    await this.database.close();
    this.database = await PostgresCollectorDatabase.open(this.testDatabase.url);
    for (const [workspace, stores] of this.workspaces) stores.postgres = new PostgresCollectorStorage(this.database, workspace);
  }

  async compare<T>(use: (store: CollectorStorage) => Promise<T>, workspace = "main"): Promise<T> {
    let stores = this.workspaces.get(workspace);
    if (!stores) {
      stores = { memory: new InMemoryCollectorStorage(), postgres: new PostgresCollectorStorage(this.database, workspace) };
      this.workspaces.set(workspace, stores);
    }
    const expected = await use(stores.memory);
    const actual = await use(stores.postgres);
    assert.deepEqual(actual, expected);
    return actual;
  }

  async commit(input: Batch, workspace?: string): Promise<void> {
    assert.equal(await this.compare(store => store.commit(input), workspace), "committed");
  }
}
