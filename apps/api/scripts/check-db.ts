import { ConsoleLogger } from "@tracerelic/shared/logging";
import { Client } from "pg";

async function checkDatabase() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  let connectionError: Error | undefined;
  // pg also emits a client error when a lost connection rejects the active query.
  client.on("error", error => { connectionError = error; });
  let result;
  try {
    await client.connect();
    result = await client.query<{ database: string; version: string }>(
      "SELECT current_database() AS database, current_setting('server_version') AS version"
    );
  } finally {
    await client.end();
  }
  if (connectionError) throw connectionError;
  return result.rows[0];
}

try {
  console.log(JSON.stringify(await checkDatabase()));
} catch {
  process.exitCode = 1;
  const logger = new ConsoleLogger();
  logger.error("Database check failed. Check DATABASE_URL and database access.");
  try {
    await logger.close();
  } catch {
    // Keep the fatal exit status if stderr fails.
  }
}
