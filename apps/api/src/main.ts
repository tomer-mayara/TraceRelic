import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { CollectorWireContract } from "@tracerelic/collector/wire-contract";
import { CollectorApi } from "./collector-api.ts";
import { CollectorCredentials } from "./collector-credentials.ts";
import { PostgresCollectorDatabase } from "./storage/collector-database.ts";
import { PostgresCollectorStorage } from "./storage/postgres-collector-storage.ts";

class ConfigurationError extends Error {}

function configuredPort(value = "3000"): number {
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port > 65_535) {
    throw new ConfigurationError("PORT must be an integer from 0 through 65535");
  }
  return port;
}

async function configuredCredentials(file: string | undefined): Promise<CollectorCredentials> {
  if (!file) throw new ConfigurationError("Set TRACERELIC_COLLECTOR_CREDENTIALS_FILE to the collector credential file");
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch {
    throw new ConfigurationError("Cannot read the collector credential file");
  }
  try {
    return new CollectorCredentials(JSON.parse(contents));
  } catch {
    throw new ConfigurationError("Invalid collector credential file");
  }
}

async function serve(port: number, credentials: CollectorCredentials, database: PostgresCollectorDatabase): Promise<void> {
  const workspaces = new Map<string, PostgresCollectorStorage>();
  const api = new CollectorApi({
    credentials,
    wireState: database,
    storageForWorkspace(workspaceId) {
      let storage = workspaces.get(workspaceId);
      if (!storage) {
        storage = new PostgresCollectorStorage(database, workspaceId);
        workspaces.set(workspaceId, storage);
      }
      return storage;
    },
    onCommit: event => console.log(JSON.stringify(event)),
  });
  const shutdown = new AbortController();
  const stopped = once(shutdown.signal, "abort");
  const stop = () => shutdown.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const address = await api.listen(port);
    console.log(JSON.stringify({ event: "listening", address }));
    await stopped;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await api.close();
  }
}

async function start(): Promise<void> {
  const port = configuredPort(process.env.PORT);
  const credentials = await configuredCredentials(process.env.TRACERELIC_COLLECTOR_CREDENTIALS_FILE);
  const config = { DATABASE_URL: process.env.DATABASE_URL };
  if (!new CollectorWireContract().is("CollectorDatabaseConfig", config)) {
    throw new ConfigurationError("Set DATABASE_URL to a PostgreSQL connection URI");
  }
  let database: PostgresCollectorDatabase;
  try {
    database = await PostgresCollectorDatabase.open(config.DATABASE_URL);
  } catch {
    throw new ConfigurationError("Cannot open collector storage. Check DATABASE_URL and database migration permissions.");
  }
  try {
    await serve(port, credentials, database);
  } finally {
    await database.close();
  }
}

if (import.meta.main) {
  try {
    await start();
  } catch (error) {
    console.error(error instanceof ConfigurationError ? error.message : "Collector API could not run");
    process.exitCode = 1;
  }
}
