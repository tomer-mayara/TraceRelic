import { Client } from "pg";
import type { CollectorTransaction, PersistedSession } from "../../src/storage/collector-database.ts";
import { batch, session, storedSource } from "./collector-wire-payloads.ts";

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
    return tx.save(write, [{ version, view }, ...peers], checkpoint, inventory);
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
