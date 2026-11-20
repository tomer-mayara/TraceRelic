import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "pg";

const exec = promisify(execFile);

async function adminQuery(url: string, sql: string): Promise<void> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Each fixture owns a new database or a loopback-only PostgreSQL container. */
export class DisposablePostgres {
  private closing?: Promise<void>;

  private constructor(readonly url: string, private readonly remove: () => Promise<void>) {}

  static async open(): Promise<DisposablePostgres> {
    const admin = process.env.TRACERELIC_TEST_DATABASE_URL;
    if (admin === undefined) return this.inContainer();
    const url = URL.parse(admin);
    if (!url || !["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Invalid TRACERELIC_TEST_DATABASE_URL");
    const name = "tracerelic_test_" + randomUUID().replaceAll("-", "");
    url.pathname = "/" + name;
    url.searchParams.delete("database");
    url.searchParams.delete("dbname");
    await adminQuery(admin, `CREATE DATABASE "${name}"`);
    return new DisposablePostgres(url.href, () => adminQuery(admin, `DROP DATABASE "${name}" WITH (FORCE)`));
  }

  private static async inContainer(): Promise<DisposablePostgres> {
    const password = randomUUID();
    const { stdout } = await exec("docker", ["run", "--rm", "--detach", "--publish", "127.0.0.1::5432",
      "--env", "POSTGRES_PASSWORD", "postgres:18.7"], { env: { ...process.env, POSTGRES_PASSWORD: password } });
    const container = stdout.trim();
    const remove = async () => { await exec("docker", ["rm", "--force", container]); };
    try {
      const binding = await exec("docker", ["port", container, "5432/tcp"]);
      const port = /^127\.0\.0\.1:(\d+)$/.exec(binding.stdout.trim())?.[1];
      if (!port) throw new Error("PostgreSQL test container has no loopback port");
      const url = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;
      const deadline = Date.now() + 30_000;
      for (;;) {
        try {
          await adminQuery(url, "SELECT 1");
          return new DisposablePostgres(url, remove);
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await setTimeout(100);
        }
      }
    } catch (error) {
      await remove();
      throw error;
    }
  }

  close(): Promise<void> { return this.closing ??= this.remove(); }
}
