import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseError, Pool, type PoolClient, type QueryResultRow } from "pg";
import { matchesSourceScope, StorageUnavailableError, type AcknowledgedSource, type Batch, type Checkpoint,
  type CheckpointSnapshot, type Message, type PresenceWrite, type SessionKey, type SessionView,
  type SourceScope, type StreamKey, type Usage } from "@tracerelic/collector/storage";

export type CollectorWrite = { kind: "batch"; value: Batch } | { kind: "presence"; value: PresenceWrite };

export interface PersistedSession { version: number; view: SessionView }

export interface CollectorTransaction {
  entriesAfter(position: string, limit?: number): Promise<{ position: string; write: CollectorWrite }[]>;
  save(write: CollectorWrite, sessions: readonly PersistedSession[], checkpoint: Checkpoint,
    inventory: AcknowledgedSource | null): Promise<string>;
}

/** PostgreSQL indexes fixed-size keys. JSON distinguishes every identifier from a missing installation. */
function identity(value: string | undefined): Buffer {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest();
}

function sessionKey(workspace: Buffer, key: SessionKey): [Buffer, string, Buffer] {
  return [workspace, key.harness, identity(key.sessionId)];
}

async function databaseCall<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    // SQL problems can include row contents in their detail. Expose only the failure category.
    if (error instanceof DatabaseError && error.severity !== "FATAL" && error.severity !== "PANIC"
        && !/^(08|40|53|57|58|55P03)/.test(error.code ?? "")) {
      throw new Error("Collector database operation failed");
    }
    throw new StorageUnavailableError("Collector database is unavailable");
  }
}

class Queries {
  constructor(private readonly connection: Pool | PoolClient) {}

  async rows<Row extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<Row[]> {
    const result = await databaseCall(() => this.connection.query<Row>(sql, values));
    return result.rows ?? [];
  }
}

class WorkspaceTransaction implements CollectorTransaction {
  constructor(private readonly workspace: Buffer, private readonly sql: Queries) {}

  entriesAfter(position: string, limit?: number): Promise<{ position: string; write: CollectorWrite }[]> {
    return this.sql.rows(`SELECT position::text AS position, entry AS write FROM tracerelic_collector.writes AS w
      WHERE workspace_key = $1 AND w.position > $2::bigint ORDER BY w.position LIMIT $3`, [this.workspace, position, limit ?? null]);
  }

  async save(write: CollectorWrite, sessions: readonly PersistedSession[], checkpoint: Checkpoint,
    inventory: AcknowledgedSource | null): Promise<string> {
    const [entry] = await this.sql.rows<{ position: string }>(
      "INSERT INTO tracerelic_collector.writes (workspace_key, entry) VALUES ($1, $2) RETURNING position::text",
      [this.workspace, JSON.stringify(write)]);
    for (const session of sessions) await this.saveSession(session, entry.position);
    const source = write.value.source;
    await this.sql.rows(`INSERT INTO tracerelic_collector.sources
      (workspace_key, harness, session_key, installation_key, stream_key, first_position, root_key, checkpoint, inventory)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (workspace_key, harness, session_key, installation_key, stream_key) DO UPDATE
      SET root_key = EXCLUDED.root_key, checkpoint = EXCLUDED.checkpoint, inventory = EXCLUDED.inventory`,
    [...sessionKey(this.workspace, source), identity(source.installationId), identity(source.streamId), entry.position,
      inventory && identity(inventory.location.root), JSON.stringify(checkpoint), inventory && JSON.stringify(inventory)]);
    return entry.position;
  }

  private async saveSession({ version, view }: PersistedSession, position: string): Promise<void> {
    const key = sessionKey(this.workspace, view.key);
    const { messages, usage, ...summary } = view;
    await this.sql.rows(`INSERT INTO tracerelic_collector.sessions
      (workspace_key, harness, session_key, first_position, version, summary) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (workspace_key, harness, session_key) DO UPDATE
      SET version = EXCLUDED.version, summary = EXCLUDED.summary`, [...key, position, version, JSON.stringify(summary)]);
    await this.saveRecords(key, "message", messages);
    await this.saveRecords(key, "usage", usage);
  }

  private async saveRecords(key: ReturnType<typeof sessionKey>, kind: "message" | "usage", rows: readonly (Message | Usage)[]) {
    // Apply the record and order changes for this session in one round trip per kind.
    await this.sql.rows(`WITH desired AS (
        SELECT decode(record_key, 'hex') AS record_key, payload, ordinal
        FROM unnest($5::text[], $6::text[]) WITH ORDINALITY AS r(record_key, payload, ordinal)
      ), upserted AS (
        INSERT INTO tracerelic_collector.records AS old (workspace_key, harness, session_key, kind, record_key, ordinal, payload)
        SELECT $1,$2,$3,$4,record_key,ordinal,payload::json FROM desired
        ON CONFLICT (workspace_key, harness, session_key, kind, record_key) DO UPDATE
        SET ordinal = EXCLUDED.ordinal, payload = EXCLUDED.payload
        WHERE (old.ordinal, old.payload::text) IS DISTINCT FROM (EXCLUDED.ordinal, EXCLUDED.payload::text)
      )
      DELETE FROM tracerelic_collector.records AS old
      WHERE old.workspace_key = $1 AND old.harness = $2 AND old.session_key = $3 AND old.kind = $4
        AND NOT EXISTS (SELECT 1 FROM desired WHERE desired.record_key = old.record_key)`,
    [...key, kind, rows.map(row => identity(row.id).toString("hex")), rows.map(row => JSON.stringify(row))]);
  }
}

export class PostgresCollectorDatabase {
  private readonly sql: Queries;

  private constructor(private readonly pool: Pool) {
    this.sql = new Queries(pool);
    // pg evicts idle connections on error. A subsequent operation can check out a fresh connection.
    pool.on("error", () => {});
    pool.on("connect", client => client.on("error", () => {}));
  }

  static async open(url: string): Promise<PostgresCollectorDatabase> {
    if (!URL.canParse(url) || !/^postgres(ql)?:\/\//.test(url)) throw new Error("Invalid collector database URL");
    const database = new PostgresCollectorDatabase(new Pool({ connectionString: url, connectionTimeoutMillis: 5000 }));
    try {
      await database.migrate();
      return database;
    } catch (error) {
      await database.close();
      throw error;
    }
  }

  close(): Promise<void> { return databaseCall(() => this.pool.end()); }

  private async migrate(): Promise<void> {
    await this.transaction(async sql => {
      // The two-integer migration lock occupies a separate key space from workspace write locks.
      await sql.rows("SELECT pg_advisory_xact_lock(1414677315, 1)");
      await sql.rows("CREATE SCHEMA IF NOT EXISTS tracerelic_collector");
      await sql.rows(`CREATE TABLE IF NOT EXISTS tracerelic_collector.schema_migrations
        (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const versions = await sql.rows<{ version: number }>("SELECT version FROM tracerelic_collector.schema_migrations ORDER BY version");
      if (versions.some(row => row.version !== 1)) throw new Error("Unsupported collector database version");
      if (versions.length) return;
      const file = new URL("../migrations/001-collector-storage.sql", import.meta.url);
      await sql.rows(await readFile(file, "utf8"));
      await sql.rows("INSERT INTO tracerelic_collector.schema_migrations (version) VALUES (1)");
    });
  }

  private async transaction<T>(action: (sql: Queries) => Promise<T>): Promise<T> {
    const client = await databaseCall(() => this.pool.connect());
    const sql = new Queries(client);
    let discard = false;
    try {
      await sql.rows("BEGIN ISOLATION LEVEL READ COMMITTED");
      const result = await action(sql);
      await sql.rows("COMMIT");
      return result;
    } catch (error) {
      try { await sql.rows("ROLLBACK"); } catch { discard = true; }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  write<T>(workspaceId: string, action: (tx: CollectorTransaction) => Promise<T>): Promise<T> {
    const workspace = identity(workspaceId);
    return this.transaction(async sql => {
      // A fresh statement snapshot after this lock includes the preceding writer's committed journal.
      await sql.rows("SELECT pg_advisory_xact_lock($1::bigint)", [workspace.readBigInt64BE().toString()]);
      return action(new WorkspaceTransaction(workspace, sql));
    });
  }

  async readSession(workspaceId: string, key: SessionKey): Promise<SessionView | null> {
    type SessionRow = { summary: Omit<SessionView, "messages" | "usage">; messages: Message[] | null; usage: Usage[] | null };
    const [row] = await this.sql.rows<SessionRow>(`SELECT s.summary,
        json_agg(r.payload ORDER BY r.ordinal) FILTER (WHERE r.kind = 'message') AS messages,
        json_agg(r.payload ORDER BY r.ordinal) FILTER (WHERE r.kind = 'usage') AS usage
      FROM tracerelic_collector.sessions s LEFT JOIN tracerelic_collector.records r USING (workspace_key, harness, session_key)
      WHERE s.workspace_key = $1 AND s.harness = $2 AND s.session_key = $3
      GROUP BY s.workspace_key, s.harness, s.session_key`, sessionKey(identity(workspaceId), key));
    return row ? { ...row.summary, messages: row.messages ?? [], usage: row.usage ?? [] } : null;
  }

  async readCheckpoint(workspaceId: string, source: StreamKey): Promise<CheckpointSnapshot> {
    const [snapshot] = await this.sql.rows<CheckpointSnapshot>(`SELECT s.version::float8 AS version, src.checkpoint
      FROM tracerelic_collector.sessions s LEFT JOIN tracerelic_collector.sources src
        ON (s.workspace_key, s.harness, s.session_key) = (src.workspace_key, src.harness, src.session_key)
        AND src.installation_key = $4 AND src.stream_key = $5
      WHERE s.workspace_key = $1 AND s.harness = $2 AND s.session_key = $3`,
    [...sessionKey(identity(workspaceId), source), identity(source.installationId), identity(source.streamId)]);
    return snapshot ?? { version: 0, checkpoint: null };
  }

  async listSources(workspaceId: string, scope: SourceScope): Promise<AcknowledgedSource[]> {
    const rows = await this.sql.rows<{ version: number; inventory: AcknowledgedSource }>(
      `SELECT s.version::float8 AS version, src.inventory
       FROM tracerelic_collector.sources src JOIN tracerelic_collector.sessions s USING (workspace_key, harness, session_key)
       WHERE src.workspace_key = $1 AND src.harness = $2 AND src.installation_key = $3 AND src.root_key = $4
       ORDER BY s.first_position, src.first_position`,
      [identity(workspaceId), scope.harness, identity(scope.installationId), identity(scope.root)]);
    return rows.filter(({ inventory }) => matchesSourceScope(scope, inventory.source, inventory.location))
      .map(({ inventory, version }) => ({ ...inventory, version }));
  }
}
