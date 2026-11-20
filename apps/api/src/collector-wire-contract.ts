import { readFileSync } from "node:fs";
import type { Batch, PresenceWrite, SessionKey, SourceScope, StreamKey } from "@tracerelic/collector/storage";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";

export interface CollectorCredentialRecord {
  tokenSha256: string;
  workspaceId: string;
  installationId: string;
  expiresAt: string;
}

interface CollectorModels {
  CollectorCredentialRecord: CollectorCredentialRecord;
  SessionKey: SessionKey;
  StreamKey: StreamKey;
  SourceScope: SourceScope;
  PresenceWrite: PresenceWrite;
  Batch: Batch;
}

const file = new URL("../dist/contracts/collector-api.schema.json", import.meta.url);
const schema: unknown = JSON.parse(readFileSync(file, "utf8"));
if (!schema || typeof schema !== "object" || !("$schema" in schema) || typeof schema.$schema !== "string") {
  throw new Error("Invalid collector API schema bundle");
}
const contract = new Ajv2020({ formats: fullFormats, ownProperties: true, strictTypes: true })
  .addSchema({ ...schema, $schema: schema.$schema });

export class CollectorWireContract {
  is<K extends keyof CollectorModels>(name: K, value: unknown): value is CollectorModels[K] {
    return contract.validate<CollectorModels[K]>(`${name}.json`, value);
  }
}
