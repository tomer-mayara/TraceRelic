import { Client } from "pg";
import type { CollectorTransaction } from "#src/storage/collector-database";
import { projectSession, type PersistedSession } from "#src/storage/collector-projection";
import type { SessionView } from "@tracerelic/collector/storage";
import { batch, session, storedSource } from "./collector-wire-payloads.ts";

export function fullProjection(version: number, view: SessionView) {
  return projectSession(version, view, { messages: [], usage: [] });
}

/** PostgreSQL must round-trip any message or identifier allowed by the JSON wire contract. */
export function projectedWrite(expectedVersion = 0, sessionId = "native\0" + "long-identifier".repeat(400), text = "hello\0\ud800 world") {
  const key = { ...session.key, sessionId };
  const source = { ...key, streamId: "source\ud83d", installationId: "local\0desktop" };
  const message = { ...session.messages[0], id: "first\0", text };
  const usage = [{ ...session.usage[0], id: message.id }];
  const version = expectedVersion + 1;
  const offset = version * 100;
  const checkpoint = { ...batch.checkpoint, offset };
  const value = { ...batch, source, expectedVersion, expectedOffset: offset - 100, checkpoint,
    sourceObservation: { ...batch.sourceObservation, observedEnd: offset }, messages: [message], usage };
  const view = { ...session, key, messages: [message], usage };
  const inventory = { ...storedSource, source, version, observedEnd: offset, acceptedOffset: offset };
  const write = { kind: "batch", value } as const;
  function save(tx: CollectorTransaction, peers: PersistedSession[] = []) {
    return tx.save(write, [fullProjection(version, view), ...peers], checkpoint, inventory);
  }
  return { write, view, inventory, save };
}

export async function migrationVersions(url: string): Promise<number[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const rows = await client.query<{ version: number }>("SELECT version FROM tracerelic_collector.schema_migrations ORDER BY version");
    return rows.rows.map(row => row.version);
  } finally {
    await client.end();
  }
}

/** Restore the summaries and migration level of an earlier API in a disposable database. */
export async function restoreLegacyCoverage(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    type Row = { workspace_key: Buffer; harness: string; session_key: Buffer; summary: Omit<SessionView, "messages" | "usage"> };
    const rows = await client.query<Row>("SELECT workspace_key, harness, session_key, summary FROM tracerelic_collector.sessions");
    for (const { workspace_key, harness, session_key, summary } of rows.rows) {
      const { usageDiagnostics: _legacy, ...before } = summary;
      await client.query("UPDATE tracerelic_collector.sessions SET summary=$4 WHERE workspace_key=$1 AND harness=$2 AND session_key=$3",
        [workspace_key, harness, session_key, JSON.stringify({ ...before, coverage: "reported" })]);
    }
    await client.query("DELETE FROM tracerelic_collector.schema_migrations WHERE version=3");
  } finally { await client.end(); }
}

/** Observe every proposed row, including an INSERT that finds an unchanged record on conflict. */
export async function countProjectionRows(url: string, start = false): Promise<number> {
  const connection = new Client({ connectionString: url });
  await connection.connect();
  try {
    if (start) await connection.query(`CREATE TABLE projection_probe (event text);
      CREATE FUNCTION count_record() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO projection_probe VALUES (TG_OP); RETURN NEW; END $$;
      CREATE TRIGGER observe_projection BEFORE INSERT ON tracerelic_collector.records
      FOR EACH ROW WHEN (NEW.kind='message') EXECUTE FUNCTION count_record()`);
    return Number((await connection.query("SELECT count(*) FROM projection_probe")).rows[0].count);
  } finally { await connection.end(); }
}

export async function stagedUploads(url: string, expire = false): Promise<number> {
  const connection = new Client({ connectionString: url });
  await connection.connect();
  try {
    if (expire) await connection.query("UPDATE tracerelic_collector.upload_parts SET expires_at=now()-interval '1 day'");
    return Number((await connection.query("SELECT count(*) FROM tracerelic_collector.upload_parts")).rows[0].count);
  } finally { await connection.end(); }
}
