import { Client } from "pg";
import { PostgresCollectorDatabase } from "#src/storage/collector-database";
import { PostgresCollectorStorage } from "#src/storage/postgres-collector-storage";
import { DisposablePostgres } from "./disposable-postgres.ts";

export class CodexIdentityDatabase {
  private constructor(private readonly disposable: DisposablePostgres, private db: PostgresCollectorDatabase) {}

  static async open() {
    const disposable = await DisposablePostgres.open();
    try { return new this(disposable, await PostgresCollectorDatabase.open(disposable.url)); }
    catch (error) { await disposable.close(); throw error; }
  }
  storage() { return new PostgresCollectorStorage(this.db, "identity-test"); }
  async reconnect() {
    await this.db.close();
    this.db = await PostgresCollectorDatabase.open(this.disposable.url);
  }
  async failAtCommit<T>(run: () => Promise<T>) {
    const client = new Client({ connectionString: this.disposable.url });
    try {
      await client.connect();
      await client.query("CREATE FUNCTION tracerelic_collector.reject_source_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'identity rollback'; END $$");
      await client.query("CREATE CONSTRAINT TRIGGER reject_source_identity AFTER INSERT ON tracerelic_collector.writes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tracerelic_collector.reject_source_identity()");
      try { return await run(); } finally { await client.query("DROP TRIGGER reject_source_identity ON tracerelic_collector.writes"); }
    } finally { await client.end(); }
  }
  async close() {
    try { await this.db.close(); } finally { await this.disposable.close(); }
  }
}
