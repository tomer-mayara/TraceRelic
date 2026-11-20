import { Client } from "pg";
import { batch, session, storedSource } from "./collector-wire-payloads.ts";

/** PostgreSQL must round-trip any message or identifier allowed by the JSON wire contract. */
export function projectedWrite() {
  const key = { ...session.key, sessionId: "native\0" + "long-identifier".repeat(400) };
  const source = { ...key, streamId: "source\ud83d", installationId: "local\0desktop" };
  const message = { ...session.messages[0], id: "first\0", text: "hello\0\ud800 world" };
  const usage = [{ ...session.usage[0], id: message.id }];
  const value = { ...batch, source, messages: [message], usage };
  const view = { ...session, key, messages: [message], usage };
  const inventory = { ...storedSource, source };
  return { write: { kind: "batch", value } as const, view, inventory };
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
