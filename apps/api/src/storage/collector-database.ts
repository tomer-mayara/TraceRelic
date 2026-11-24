import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseError, Pool, type PoolClient, type QueryResultRow } from "pg";
import type { CollectorScope } from "../collector-credentials.ts";
import type { SessionRevision } from "@tracerelic/collector/memory-storage";
import { LegacyScannerSource, SourceScopes, StorageUnavailableError, type AcknowledgedSource, type Batch, type Checkpoint,
  type CheckpointSnapshot, type Message, type PresenceWrite, type SessionKey, type SessionView,
  type SourceScope, type StreamKey, type Usage } from "@tracerelic/collector/storage";
import type { PersistedSession, RecordChanges, SessionRecords } from "./collector-projection.ts";

export type CollectorWrite = { kind: "batch"; value: Batch } | { kind: "presence"; value: PresenceWrite };

type SourceAliasWrite = { kind: "alias"; value: { source: StreamKey; target: string; expectedVersion: number } };
export type JournalWrite = CollectorWrite | SourceAliasWrite;
interface JournalEntry { position: string; write: JournalWrite; revisions?: SessionRevision[] }

export class SessionVersionConflict extends Error {
  constructor() { super("Collector session version conflict"); }
}

export interface CollectorTransaction {
  saveAlias(write: SourceAliasWrite, summary: PersistedSession["summary"]): Promise<string>;
  recordsFor(key: SessionKey): Promise<SessionRecords>;
  storedVersions(keys: readonly SessionKey[]): Promise<SessionRevision[]>;
  entriesAfter(position: string, limit?: number): Promise<JournalEntry[]>;
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

/** Migration 3 updates projections that would otherwise wait indefinitely for the collector to reconnect. */
async function flagUnverifiedHistory(sql: Queries): Promise<void> {
  // A JSON wire string can contain NUL or unpaired surrogates. Select candidates by text and decode the
  // original JSON in the application, just as the journal reader does. A cursor bounds the working set.
  await sql.rows(`DECLARE prior_sources NO SCROLL CURSOR FOR
    SELECT workspace_key, checkpoint, inventory, NULL::json AS write FROM tracerelic_collector.sources
      WHERE inventory::text LIKE '%"missing"%'
    UNION ALL
    SELECT workspace_key, NULL::json, NULL::json, entry FROM tracerelic_collector.writes
      WHERE entry::text LIKE '%"resetFrom"%'`);
  type Row = { workspace_key: Buffer; checkpoint: Checkpoint | null; inventory: AcknowledgedSource | null; write: CollectorWrite | null };
  for (;;) {
    const rows = await sql.rows<Row>("FETCH FORWARD 32 FROM prior_sources");
    if (!rows.length) break;
    for (const { workspace_key, checkpoint, inventory, write } of rows) {
      const reset = write?.kind === "batch" && write.value.resetFrom;
      const source = reset ? write.value.source : inventory?.presence === "missing" && inventory.source;
      const prior = reset || checkpoint;
      if (!source || !prior) continue;
      const key = sessionKey(workspace_key, source);
      let location = reset ? write.value.sourceObservation?.location : inventory?.location;
      if (reset && !location && !LegacyScannerSource.needsHistoryVerification(source, prior)) {
        const [saved] = await sql.rows<Pick<Row, "inventory">>(`SELECT inventory FROM tracerelic_collector.sources
          WHERE workspace_key=$1 AND harness=$2 AND session_key=$3 AND installation_key=$4 AND stream_key=$5`,
        [...key, identity(source.installationId), identity(source.streamId)]);
        location = saved?.inventory?.location;
      }
      if (!LegacyScannerSource.needsHistoryVerification(source, prior, location)) continue;
      const [row] = await sql.rows<{ summary: Omit<SessionView, "messages" | "usage"> }>(
        "SELECT summary FROM tracerelic_collector.sessions WHERE workspace_key=$1 AND harness=$2 AND session_key=$3 FOR UPDATE", key);
      const summary = row.summary;
      const diagnostics = summary.usageDiagnostics ?? [];
      if (diagnostics.some(d => d.code === "unverified-source-history" && d.streamId === source.streamId && d.installationId === source.installationId)) continue;
      const coverage = summary.observedTotalTokens === null ? "unknown" : "partial";
      await sql.rows("UPDATE tracerelic_collector.sessions SET summary=$4 WHERE workspace_key=$1 AND harness=$2 AND session_key=$3",
        [...key, JSON.stringify({ ...summary, coverage, usageDiagnostics: [...diagnostics, LegacyScannerSource.historyDiagnostic(source)] })]);
    }
  }
  await sql.rows("CLOSE prior_sources");
}

class WorkspaceTransaction implements CollectorTransaction {
  constructor(private readonly workspace: Buffer, private readonly sql: Queries) {}

  private async append(write: JournalWrite, revisions: SessionRevision[]) {
    const [entry] = await this.sql.rows<{ position: string }>(
      "INSERT INTO tracerelic_collector.writes (workspace_key, entry) VALUES ($1, $2) RETURNING position::text",
      [this.workspace, JSON.stringify({ ...write, revisions })]);
    return entry.position;
  }

  async saveAlias(write: SourceAliasWrite, summary: PersistedSession["summary"]) {
    const { source, target, expectedVersion } = write.value;
    const key = sessionKey(this.workspace, source);
    const [saved] = await this.sql.rows(`UPDATE tracerelic_collector.sessions SET summary=$4
      WHERE workspace_key=$1 AND harness=$2 AND session_key=$3 AND version=$5 RETURNING 1`,
    [...key, JSON.stringify(summary), expectedVersion]);
    if (!saved) throw new SessionVersionConflict();
    await this.sql.rows(`INSERT INTO tracerelic_collector.source_aliases
      (workspace_key,harness,session_key,installation_key,stream_key,target) VALUES ($1,$2,$3,$4,$5,$6)`,
    [...key, identity(source.installationId), identity(source.streamId), JSON.stringify(target)]);
    return this.append(write, []);
  }

  async entriesAfter(position: string, limit?: number): Promise<JournalEntry[]> {
    const rows = await this.sql.rows<{ position: string; entry: JournalWrite & { revisions?: SessionRevision[] } }>(
      `SELECT position::text AS position, entry FROM tracerelic_collector.writes AS w
      WHERE workspace_key = $1 AND w.position > $2::bigint ORDER BY w.position LIMIT $3`, [this.workspace, position, limit ?? null]);
    return rows.map(({ position, entry: { revisions, ...write } }) => ({ position, write, revisions }));
  }

  async storedVersions(keys: readonly SessionKey[]): Promise<SessionRevision[]> {
    const rows = await this.sql.rows<{ index: number; version: number }>(`SELECT wanted.ordinal::int-1 AS index, s.version::float8 AS version
      FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS wanted(harness, key, ordinal)
      JOIN tracerelic_collector.sessions s ON s.workspace_key=$1 AND s.harness=wanted.harness AND s.session_key=decode(wanted.key,'hex')`,
    [this.workspace, keys.map(key => key.harness), keys.map(key => identity(key.sessionId).toString("hex"))]);
    return rows.map(row => ({ ...keys[row.index], version: row.version }));
  }

  async recordsFor(key: SessionKey): Promise<SessionRecords> {
    const [row] = await this.sql.rows<SessionRecords>(`SELECT
        COALESCE(json_agg(payload ORDER BY ordinal) FILTER (WHERE kind='message'), '[]') AS messages,
        COALESCE(json_agg(payload ORDER BY ordinal) FILTER (WHERE kind='usage'), '[]') AS usage
      FROM tracerelic_collector.records WHERE workspace_key=$1 AND harness=$2 AND session_key=$3`, sessionKey(this.workspace, key));
    return row;
  }

  async save(write: CollectorWrite, sessions: readonly PersistedSession[], checkpoint: Checkpoint,
    inventory: AcknowledgedSource | null): Promise<string> {
    const { source, expectedVersion } = write.value;
    const sourceSession = sessions.find(({ summary: { key } }) => key.harness === source.harness && key.sessionId === source.sessionId);
    if (!sourceSession) throw new Error("Accepted collector write has no source session");
    const position = await this.append(write, sessions.map(({ summary, version }) => ({ ...summary.key, version })));
    await this.saveSession(sourceSession, expectedVersion, position);
    for (const peer of sessions) {
      if (peer !== sourceSession) await this.saveSession(peer, peer.version - 1);
    }
    await this.sql.rows(`INSERT INTO tracerelic_collector.sources
      (workspace_key, harness, session_key, installation_key, stream_key, first_position, root_key, checkpoint, inventory)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (workspace_key, harness, session_key, installation_key, stream_key) DO UPDATE
      SET root_key = EXCLUDED.root_key, checkpoint = EXCLUDED.checkpoint, inventory = EXCLUDED.inventory`,
    [...sessionKey(this.workspace, source), identity(source.installationId), identity(source.streamId), position,
      inventory && identity(inventory.location.root), JSON.stringify(checkpoint), inventory && JSON.stringify(inventory)]);
    return position;
  }

  private async saveSession({ version, summary, messages, usage }: PersistedSession, expectedVersion: number, firstPosition?: string): Promise<void> {
    const key = sessionKey(this.workspace, summary.key);
    const values = [...key, JSON.stringify(summary)];
    // A source can create a session. An ownership transfer must find an existing peer at its expected version.
    const [saved] = expectedVersion === 0 && firstPosition !== undefined
      ? await this.sql.rows<{ version: number }>(`INSERT INTO tracerelic_collector.sessions
          (workspace_key, harness, session_key, summary, first_position, version) VALUES ($1,$2,$3,$4,$5,1)
          ON CONFLICT (workspace_key, harness, session_key) DO NOTHING RETURNING version::float8 AS version`, [...values, firstPosition])
      : await this.sql.rows<{ version: number }>(`UPDATE tracerelic_collector.sessions SET summary = $4, version = version + 1
          WHERE workspace_key = $1 AND harness = $2 AND session_key = $3 AND version = $5
          RETURNING version::float8 AS version`, [...values, expectedVersion]);
    if (saved?.version !== version) throw new SessionVersionConflict();
    await this.saveRecords(key, "message", messages);
    await this.saveRecords(key, "usage", usage);
  }

  private async saveRecords(key: ReturnType<typeof sessionKey>, kind: "message" | "usage", { upserts, removed }: RecordChanges<Message | Usage>) {
    if (!upserts.length && !removed.length) return;
    await this.sql.rows(`WITH changed AS (
        SELECT decode(record_key, 'hex') AS record_key, payload, ordinal
        FROM unnest($5::text[], $6::text[], $7::bigint[]) AS r(record_key, payload, ordinal)
      ), upserted AS (
        INSERT INTO tracerelic_collector.records (workspace_key, harness, session_key, kind, record_key, ordinal, payload)
        SELECT $1,$2,$3,$4,record_key,ordinal,payload::json FROM changed
        ON CONFLICT (workspace_key, harness, session_key, kind, record_key) DO UPDATE
        SET ordinal = EXCLUDED.ordinal, payload = EXCLUDED.payload
      )
      DELETE FROM tracerelic_collector.records
      WHERE workspace_key=$1 AND harness=$2 AND session_key=$3 AND kind=$4
        AND record_key IN (SELECT decode(id,'hex') FROM unnest($8::text[]) AS id)`,
    [...key, kind, upserts.map(({ record }) => identity(record.id).toString("hex")), upserts.map(({ record }) => JSON.stringify(record)),
      upserts.map(({ ordinal }) => ordinal), removed.map(id => identity(id).toString("hex"))]);
  }
}

async function lookupAlias(sql: Queries, workspace: Buffer, source: StreamKey): Promise<string | undefined> {
  const [row] = await sql.rows<{ target: string }>(`SELECT target FROM tracerelic_collector.source_aliases
    WHERE workspace_key=$1 AND harness=$2 AND session_key=$3 AND installation_key=$4 AND stream_key=$5`,
  [...sessionKey(workspace, source), identity(source.installationId), identity(source.streamId)]);
  return row?.target;
}

export class PostgresCollectorDatabase {
  private readonly sql: Queries;
  private expiration?: NodeJS.Timeout;

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
      await database.expireUploads();
      database.expiration = setInterval(() => { void database.expireUploads().catch(() => {}); }, 3_600_000).unref();
      return database;
    } catch (error) {
      await database.close();
      throw error;
    }
  }

  close(): Promise<void> {
    clearInterval(this.expiration);
    return databaseCall(() => this.pool.end());
  }

  private expireUploads() { return this.sql.rows("DELETE FROM tracerelic_collector.upload_parts WHERE expires_at < now()"); }

  async putPart(scope: CollectorScope, upload: string, index: number, data: Buffer): Promise<boolean> {
    const rows = await this.sql.rows(`INSERT INTO tracerelic_collector.upload_parts AS existing
      (workspace_key,installation_key,upload,part_index,payload,expires_at) VALUES ($1,$2,$3,$4,$5,now()+interval '1 day')
      ON CONFLICT (workspace_key,installation_key,upload,part_index) DO UPDATE SET payload=excluded.payload, expires_at=excluded.expires_at
      WHERE existing.payload=excluded.payload OR existing.expires_at<now() RETURNING 1`, [identity(scope.workspaceId), identity(scope.installationId), upload, index, data]);
    return rows.length === 1;
  }

  async parts(scope: CollectorScope, upload: string, count: number): Promise<Buffer[] | undefined> {
    const rows = await this.sql.rows<{ index: number; payload: Buffer }>(`SELECT part_index::float8 AS index,payload
      FROM tracerelic_collector.upload_parts WHERE workspace_key=$1 AND installation_key=$2 AND upload=$3 AND expires_at>=now()
      ORDER BY part_index`, [identity(scope.workspaceId), identity(scope.installationId), upload]);
    if (rows.length === count && rows.every((row, index) => row.index === index)) return rows.map(row => row.payload);
  }

  async discardParts(scope: CollectorScope, upload: string) {
    await this.sql.rows("DELETE FROM tracerelic_collector.upload_parts WHERE workspace_key=$1 AND installation_key=$2 AND upload=$3",
      [identity(scope.workspaceId), identity(scope.installationId), upload]);
  }

  canonical(workspaceId: string, source: StreamKey) { return lookupAlias(this.sql, identity(workspaceId), source); }

  private async migrate(): Promise<void> {
    await this.transaction(async sql => {
      // The two-integer migration lock occupies a separate key space from workspace write locks.
      await sql.rows("SELECT pg_advisory_xact_lock(1414677315, 1)");
      await sql.rows("CREATE SCHEMA IF NOT EXISTS tracerelic_collector");
      await sql.rows(`CREATE TABLE IF NOT EXISTS tracerelic_collector.schema_migrations
        (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const versions = await sql.rows<{ version: number }>("SELECT version FROM tracerelic_collector.schema_migrations ORDER BY version");
      const migrations = ["001-collector-storage.sql", "002-collector-wire.sql", flagUnverifiedHistory];
      if (versions.some((row, index) => row.version !== index + 1 || row.version > migrations.length)) throw new Error("Unsupported collector database version");
      for (let index = versions.length; index < migrations.length; index++) {
        const migration = migrations[index];
        if (typeof migration === "string") await sql.rows(await readFile(new URL("../migrations/" + migration, import.meta.url), "utf8"));
        else await migration(sql);
        await sql.rows("INSERT INTO tracerelic_collector.schema_migrations (version) VALUES ($1)", [index + 1]);
      }
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
    const [snapshot] = await this.sql.rows<CheckpointSnapshot & { inventory: AcknowledgedSource | null }>(`SELECT s.version::float8 AS version, src.checkpoint, src.inventory
      FROM tracerelic_collector.sessions s LEFT JOIN tracerelic_collector.sources src
        ON (s.workspace_key, s.harness, s.session_key) = (src.workspace_key, src.harness, src.session_key)
        AND src.installation_key = $4 AND src.stream_key = $5
      WHERE s.workspace_key = $1 AND s.harness = $2 AND s.session_key = $3`,
    [...sessionKey(identity(workspaceId), source), identity(source.installationId), identity(source.streamId)]);
    if (!snapshot) return { version: 0, checkpoint: null };
    const { version, checkpoint, inventory } = snapshot;
    const observedThrough = inventory?.unrecovered ?? (inventory && inventory.observedEnd > (checkpoint?.offset ?? 0)
      ? { offset: inventory.observedEnd, ...(inventory.observedPrefixDigest && { prefixDigest: inventory.observedPrefixDigest }) } : undefined);
    return { version, checkpoint, ...(observedThrough && { observedThrough }) };
  }

  async listSources(workspaceId: string, scope: SourceScope): Promise<AcknowledgedSource[]> {
    const rows = await this.sql.rows<{ version: number; inventory: AcknowledgedSource }>(
      `SELECT s.version::float8 AS version, src.inventory
       FROM tracerelic_collector.sources src JOIN tracerelic_collector.sessions s USING (workspace_key, harness, session_key)
       WHERE src.workspace_key = $1 AND src.harness = $2 AND src.installation_key = $3 AND src.root_key = $4
         AND NOT EXISTS (SELECT 1 FROM tracerelic_collector.source_aliases a
           WHERE (a.workspace_key,a.harness,a.session_key,a.installation_key,a.stream_key)
             = (src.workspace_key,src.harness,src.session_key,src.installation_key,src.stream_key))
       ORDER BY s.first_position, src.first_position`,
      [identity(workspaceId), scope.harness, identity(scope.installationId), identity(scope.root)]);
    return rows.filter(({ inventory }) => SourceScopes.matches(scope, inventory.source, inventory.location))
      .map(({ inventory, version }) => ({ ...inventory, version }));
  }
}
