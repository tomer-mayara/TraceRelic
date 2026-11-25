import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import type { AcknowledgedSource, Batch, Checkpoint, SessionView } from "@tracerelic/collector/storage";
import type { CollectorTransaction } from "#src/storage/collector-database";

type CollectorWrite = Parameters<CollectorTransaction["save"]>[0];

interface LegacyEntry<Write extends CollectorWrite = CollectorWrite> {
  write: Write;
  changed: { version: number; view: SessionView }[];
  inventory: AcknowledgedSource | null;
  checkpoint?: Checkpoint;
}

const directory = import.meta.resolve("@tracerelic/api/package.json");
const hash = (value?: string) => createHash("sha256").update(JSON.stringify(value ?? null)).digest();

async function seedSession(client: Client, workspace: Buffer, position: string, { version, view }: LegacyEntry["changed"][number]) {
  const { messages, usage, ...summary } = view;
  const session = [workspace, view.key.harness, hash(view.key.sessionId)];
  await client.query(`INSERT INTO tracerelic_collector.sessions (workspace_key,harness,session_key,first_position,version,summary)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_key,harness,session_key) DO UPDATE
    SET version=excluded.version, summary=excluded.summary`, [...session, position, version, JSON.stringify(summary)]);
  await client.query("DELETE FROM tracerelic_collector.records WHERE workspace_key=$1 AND harness=$2 AND session_key=$3", session);
  for (const [kind, records] of [["message", messages], ["usage", usage]] as const) {
    for (const [index, row] of records.entries()) await client.query(`INSERT INTO tracerelic_collector.records
      (workspace_key,harness,session_key,kind,record_key,ordinal,payload) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [...session, kind, hash(row.id), index + 1, JSON.stringify(row)]);
  }
}

/** The inputs and snapshots in the fixtures were produced by the original LC-17 reducer at 862402c. */
export function lc17Journal(name: "claude" | "codex"): Promise<LegacyEntry<{ kind: "batch"; value: Batch }>[]>;
export function lc17Journal(name: "claude-reset" | "codex-recovery"): Promise<LegacyEntry[]>;
export async function lc17Journal(name: "claude" | "codex" | "claude-reset" | "codex-recovery"): Promise<LegacyEntry[]> {
  const file = new URL(`test/fixtures/lc17-${name}-journal.jsonl`, directory);
  return (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
}

/** Install schema 1 and the unversioned writes and records as accepted. No current reducer runs during seeding. */
export async function seedLc17(url: string, entries: LegacyEntry[], workspaceId = "legacy") {
  const client = new Client({ connectionString: url });
  await client.connect();
  const key = hash(workspaceId);
  try {
    await client.query("CREATE SCHEMA tracerelic_collector");
    await client.query("CREATE TABLE tracerelic_collector.schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    await client.query("INSERT INTO tracerelic_collector.schema_migrations (version) VALUES (1)");
    await client.query(await readFile(new URL("dist/migrations/001-collector-storage.sql", directory), "utf8"));
    for (const entry of entries) {
      const { write, changed, inventory } = entry;
      const { source } = write.value;
      const checkpoint = write.kind === "batch" ? write.value.checkpoint : entry.checkpoint;
      const inserted = await client.query("INSERT INTO tracerelic_collector.writes (workspace_key,entry) VALUES ($1,$2) RETURNING position",
        [key, JSON.stringify(write)]);
      const position = inserted.rows[0].position;
      for (const session of changed) await seedSession(client, key, position, session);
      await client.query(`INSERT INTO tracerelic_collector.sources
        (workspace_key,harness,session_key,installation_key,stream_key,first_position,root_key,checkpoint,inventory)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(workspace_key,harness,session_key,installation_key,stream_key)
        DO UPDATE SET root_key=excluded.root_key, checkpoint=excluded.checkpoint, inventory=excluded.inventory`,
      [key, source.harness, hash(source.sessionId),hash(source.installationId),hash(source.streamId),position,
        inventory && hash(inventory.location.root), JSON.stringify(checkpoint), inventory && JSON.stringify(inventory)]);
    }
  } finally { await client.end(); }
}

export async function failCheckpointWrites(url: string, enabled: boolean) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    if (enabled) await client.query(`CREATE FUNCTION fail_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture checkpoint rollback'; END $$;
      CREATE TRIGGER fail_checkpoint_write BEFORE UPDATE ON tracerelic_collector.sources FOR EACH ROW EXECUTE FUNCTION fail_checkpoint()`);
    else await client.query("DROP TRIGGER fail_checkpoint_write ON tracerelic_collector.sources");
  } finally { await client.end(); }
}
