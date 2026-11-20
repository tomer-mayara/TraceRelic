import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpCollectorStorage } from "@tracerelic/collector/http-storage";
import type { Batch, CollectorStorage } from "@tracerelic/collector/storage";
import type { CommitMetric } from "#src/collector-api";
import { CollectorApiProcess } from "./collector-api-process.ts";
import { credentialRecord } from "./collector-credential.ts";
import { batch, source } from "./collector-wire-payloads.ts";
import { DisposablePostgres } from "./disposable-postgres.ts";

export interface WorkspaceClients {
  a: CollectorStorage;
  b: CollectorStorage;
  post(workspace: "a" | "b", body: object): Promise<Response>;
  nextCommitMetric(): Promise<CommitMetric>;
}

export function firstBatch(tokens: number, offset: number, id = "planning"): Batch {
  return {
    source: { ...source, installationId: "desktop" }, expectedVersion: 0, expectedOffset: 0,
    checkpoint: { offset, parserState: JSON.stringify({ lastRecord: id }) },
    messages: [{ ...batch.messages[0], id, text: `Recorded ${tokens} tokens` }],
    usage: [{ id, at: batch.usage[0].at, kind: "call", revision: 1, inputTokens: tokens, outputTokens: 0 }],
  };
}

export class DurableApiFixture {
  private readonly processes = new Set<CollectorApiProcess>();
  private readonly tokens = { a: randomUUID(), b: randomUUID() };
  private readonly file: string;

  private constructor(private readonly database: DisposablePostgres, private readonly directory: string) {
    this.file = join(directory, "credentials.json");
  }

  static async open(): Promise<DurableApiFixture> {
    const directory = await mkdtemp(join(tmpdir(), "tracerelic-durable-api-"));
    let database: DisposablePostgres | undefined;
    try {
      database = await DisposablePostgres.open();
      const api = new DurableApiFixture(database, directory);
      await writeFile(api.file, JSON.stringify([
        credentialRecord(api.tokens.a, "workspace-a"), credentialRecord(api.tokens.b, "workspace-b"),
      ]), { mode: 0o600 });
      return api;
    } catch (error) {
      await Promise.all([database?.close(), rm(directory, { recursive: true, force: true })]);
      throw error;
    }
  }

  get databaseUrl(): string { return this.database.url; }

  async start(): Promise<WorkspaceClients> {
    const process = new CollectorApiProcess(this.file, this.database.url);
    this.processes.add(process);
    const ready = await process.nextEvent();
    assert.equal(ready.event, "listening");
    return { a: new HttpCollectorStorage(ready.address, this.tokens.a), b: new HttpCollectorStorage(ready.address, this.tokens.b),
      post: (workspace, body) => fetch(new URL("/v1/collector/batches", ready.address), { method: "POST",
        headers: { authorization: "Bearer " + this.tokens[workspace], "content-type": "application/json" }, body: JSON.stringify(body) }),
      nextCommitMetric: () => process.nextEvent() };
  }

  private async stop(): Promise<void> {
    const exits = await Promise.all([...this.processes].map(process => process.stop("SIGTERM")));
    this.processes.clear();
    for (const exit of exits) assert.deepEqual(exit, [0, null]);
  }

  async restart(): Promise<WorkspaceClients> {
    await this.stop();
    return this.start();
  }

  async close(): Promise<void> {
    try {
      await this.stop();
    } finally {
      await Promise.all([this.database.close(), rm(this.directory, { recursive: true, force: true })]);
    }
  }
}
