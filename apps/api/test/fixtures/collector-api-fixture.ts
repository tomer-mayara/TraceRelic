import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
import { InMemoryCollectorStorage } from "@tracerelic/collector/memory-storage";
import type {
  AcknowledgedSource, Batch, CheckpointSnapshot, CollectorStorage, CommitResult, PresenceWrite, SessionKey, SessionView, SourceScope, StreamKey,
} from "@tracerelic/collector/storage";
import { CollectorApi } from "#src/collector-api";
import { CollectorCredentials } from "#src/collector-credentials";
import { credentialRecord } from "./collector-credential.ts";

const schema: unknown = JSON.parse(readFileSync(new URL("./dist/contracts/collector-api.schema.json",
  import.meta.resolve("@tracerelic/api/package.json")), "utf8"));
assert(schema && typeof schema === "object" && "$schema" in schema && typeof schema.$schema === "string");
const contract = new Ajv2020({ formats: fullFormats }).addSchema({ ...schema, $schema: schema.$schema });

type Route = "session" | "checkpoint" | "sources" | "batches" | "presence";

export class LoopbackStorage implements CollectorStorage {
  constructor(private readonly address: string, private readonly token: string) {}

  post(route: Route, body: unknown): Promise<Response> {
    return fetch(new URL(`/v1/collector/${route}`, this.address), {
      method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(4_000),
    });
  }

  private async read(route: Route, body: unknown): Promise<unknown> {
    const response = await this.post(route, body);
    assert.equal(response.status, 200, `read ${route}`);
    return response.json();
  }

  async readSession(key: SessionKey): Promise<SessionView | null> {
    const value = await this.read("session", key);
    assert(contract.validate<{ session: SessionView | null }>("SessionResult.json", value), contract.errorsText());
    return value.session;
  }

  async readCheckpoint(source: StreamKey): Promise<CheckpointSnapshot> {
    const value = await this.read("checkpoint", source);
    assert(contract.validate<CheckpointSnapshot>("CheckpointSnapshot.json", value), contract.errorsText());
    return value;
  }

  async listSources(scope: SourceScope): Promise<AcknowledgedSource[]> {
    const rows = await this.read("sources", scope);
    assert(Array.isArray(rows));
    return rows.map((row: unknown) => {
      assert(contract.validate<AcknowledgedSource>("AcknowledgedSource.json", row), contract.errorsText());
      return row;
    });
  }

  private async write(route: "batches" | "presence", body: Batch | PresenceWrite): Promise<CommitResult> {
    const response = await this.post(route, body);
    const value: unknown = await response.json();
    assert(value && typeof value === "object" && "result" in value, `unexpected ${route} response, HTTP ${response.status}`);
    const result = value.result;
    assert(contract.validate<CommitResult>("CommitResult.json", result), contract.errorsText());
    assert.equal(response.status, { committed: 200, conflict: 409, invalid: 422 }[result]);
    return result;
  }

  commit(batch: Batch): Promise<CommitResult> { return this.write("batches", batch); }
  recordPresence(update: PresenceWrite): Promise<CommitResult> { return this.write("presence", update); }
}

export class CollectorApiFixture {
  private now = Date.UTC(2026, 0, 1);
  private readonly tokens = { a: randomUUID(), b: randomUUID(), laptop: randomUUID(), expiring: randomUUID() };
  private readonly server: CollectorApi;
  private address = "";

  private constructor() {
    const credentials = new CollectorCredentials([
      credentialRecord(this.tokens.a), credentialRecord(this.tokens.b, "workspace-b"),
      credentialRecord(this.tokens.laptop, "workspace-a", "laptop"),
      { ...credentialRecord(this.tokens.expiring), expiresAt: new Date(this.now + 1000).toISOString() },
    ], () => this.now);
    const stores = new Map([["workspace-a", new InMemoryCollectorStorage()], ["workspace-b", new InMemoryCollectorStorage()]]);
    this.server = new CollectorApi({ credentials, storageForWorkspace: id => {
      const storage = stores.get(id);
      assert(storage, "unknown fixture workspace");
      return storage;
    } });
  }

  static async open(): Promise<CollectorApiFixture> {
    const fixture = new CollectorApiFixture();
    fixture.address = await fixture.server.listen(0);
    return fixture;
  }

  get a(): LoopbackStorage { return new LoopbackStorage(this.address, this.tokens.a); }
  get b(): LoopbackStorage { return new LoopbackStorage(this.address, this.tokens.b); }
  get laptop(): LoopbackStorage { return new LoopbackStorage(this.address, this.tokens.laptop); }
  get expiring(): LoopbackStorage { return new LoopbackStorage(this.address, this.tokens.expiring); }

  expireCredential(): void { this.now += 1000; }
  close(): Promise<void> { return this.server.close(); }
}
