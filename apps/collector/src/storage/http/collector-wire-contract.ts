import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
export { LegacyScannerSource } from "../collector-storage.ts";
import type { BatchPart, PackedBatch } from "./packed-batch.ts";
export { batchPartBytes, collectorRequestBytes, PackedBatches } from "./packed-batch.ts";
export type { BatchPart, PackedBatch } from "./packed-batch.ts";
import type { AcknowledgedSource, Batch, CheckpointSnapshot, CommitResult,
  PresenceWrite, SessionKey, SessionView, SourceScope, StreamKey } from "../collector-storage.ts";

export interface CollectorCredentialRecord {
  tokenSha256: string;
  workspaceId: string;
  installationId: string;
  expiresAt: string;
}

interface CollectorModels {
  BatchPart: BatchPart;
  PackedBatch: PackedBatch;
  CollectorCredentialRecord: CollectorCredentialRecord;
  CollectorDatabaseConfig: { DATABASE_URL: string };
  SessionKey: SessionKey;
  StreamKey: StreamKey;
  SourceScope: SourceScope;
  PresenceWrite: PresenceWrite;
  Batch: Batch;
  SessionResult: { session: SessionView | null };
  CheckpointSnapshot: CheckpointSnapshot;
  AcknowledgedSource: AcknowledgedSource;
  CommitResult: CommitResult;
}

export class CollectorWireContract {
  private static bundle?: Ajv2020;
  private readonly validator = CollectorWireContract.bundle ??= CollectorWireContract.load();

  private static load(): Ajv2020 {
    const file = new URL("../../../dist/contracts/collector-api.schema.json", import.meta.url);
    const schema: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!schema || typeof schema !== "object" || !("$schema" in schema) || typeof schema.$schema !== "string") {
      throw new Error("Invalid collector API schema bundle");
    }
    return new Ajv2020({ formats: fullFormats, ownProperties: true, strictTypes: true })
      .addSchema({ ...schema, $schema: schema.$schema });
  }

  is<K extends keyof CollectorModels>(name: K, value: unknown): value is CollectorModels[K] {
    return this.validator.validate<CollectorModels[K]>(`${name}.json`, value);
  }
}
