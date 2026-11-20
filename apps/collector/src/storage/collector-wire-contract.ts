import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";
export { legacyScannerLocation } from "./collector-storage.ts";
import { recordedPathDialect } from "@tracerelic/shared";
import type { BatchPart, PackedBatch } from "./collector-batch-wire.ts";
export { batchPartBytes, collectorRequestBytes, decodeBase64, fitsWireRecords, packBatch, stateBytes, unpackBatch, wireDigest } from "./collector-batch-wire.ts";
export type { BatchPart, PackedBatch } from "./collector-batch-wire.ts";
import { legacyScannerLocation, type AcknowledgedSource, type Batch, type CheckpointSnapshot, type CommitResult, type Harness,
  type PresenceWrite, type SessionKey, type SessionView, type SourceLocation, type SourceScope, type StreamKey } from "./collector-storage.ts";

/** Recognize the two documented scanner keys. Other storage clients may use arbitrary stream IDs. */
export function legacyScannerStream(harness: Harness, { root, path }: SourceLocation): string | undefined {
  const dialect = recordedPathDialect(root);
  if (!dialect) return;
  const candidate = harness === "codex" ? JSON.stringify([root, path]) : dialect.join(root, path);
  const parsed = legacyScannerLocation(harness, candidate);
  if (parsed?.root === root && parsed.path === path) return candidate;
}

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
    const file = new URL("../../dist/contracts/collector-api.schema.json", import.meta.url);
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
