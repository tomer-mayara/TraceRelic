import assert from "node:assert/strict";
import { test } from "node:test";
import { CollectorWireContract } from "@tracerelic/collector/wire-contract";
import { credentialRecord } from "../../fixtures/collector-credential.ts";
import { batch, key, presence, scope, source } from "../../fixtures/collector-wire-payloads.ts";

test("the request validator accepts all five storage operations without changing their data", () => {
  const contract = new CollectorWireContract();
  for (const [model, input] of [["SessionKey", key], ["StreamKey", source], ["SourceScope", scope],
    ["PresenceWrite", presence], ["Batch", batch]] as const) {
    const original = structuredClone(input);
    assert.equal(contract.is(model, input), true, model);
    assert.deepEqual(input, original);
  }
  const extendedSource = { ...source, installationId: "desktop", clientLabel: "planning" };
  const original = structuredClone(extendedSource);
  assert(contract.is("StreamKey", extendedSource));
  assert.deepEqual(extendedSource, original);
});

test("the request validator enforces JSON types, timestamps and conditional batch fields", () => {
  const contract = new CollectorWireContract();
  for (const [model, input] of [["SessionKey", null], ["SessionKey", { ...key, sessionId: "" }],
    ["StreamKey", { ...source, streamId: 1 }], ["SourceScope", { ...scope, sessionIds: [42] }],
    ["PresenceWrite", { ...presence, expectedVersion: "1" }], ["Batch", { ...batch, messages: null }],
    ["Batch", { ...batch, usage: [{ ...batch.usage[0], at: "2026-02-30T10:00:00Z" }] }],
    ["Batch", { ...batch, usage: [{ ...batch.usage[0], inputTokens: Number.MAX_SAFE_INTEGER + 1 }] }],
    ["Batch", { ...batch, usageDiagnostics: [{ code: "malformed-transcript-line", sourceOrder: 1 }] }]] as const) {
    const original = structuredClone(input);
    assert.equal(contract.is(model, input), false, model);
    assert.deepEqual(input, original);
  }
});

test("the generated credential record schema requires a digest, scope and explicit expiry", () => {
  const contract = new CollectorWireContract();
  const record = credentialRecord("local-test-token");
  assert(contract.is("CollectorCredentialRecord", record));
  for (const invalid of [{ ...record, tokenSha256: "too-short" }, { ...record, workspaceId: " " },
    { ...record, installationId: "\u0000" }, { ...record, expiresAt: "2026-01-01T12:00:00" },
    { ...record, token: "extra" }]) {
    assert.equal(contract.is("CollectorCredentialRecord", invalid), false);
  }
});

test("the generated database configuration schema requires a PostgreSQL connection URI", () => {
  const contract = new CollectorWireContract();
  for (const url of ["postgres://localhost/store", "postgresql:///store?host=%2Ftmp", "postgresql://localhost/store%20name"]) {
    assert(contract.is("CollectorDatabaseConfig", { DATABASE_URL: url }));
  }
  for (const config of [{}, { DATABASE_URL: "https://localhost/store" }, { DATABASE_URL: "postgres://localhost/store name" }]) {
    assert.equal(contract.is("CollectorDatabaseConfig", config), false);
  }
});
