import { Client } from "pg";

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const result = await client.query(
    "SELECT current_database() AS database, current_setting('server_version') AS version"
  );
  console.log(result.rows[0]);
} finally {
  await client.end();
}
