import { createHash } from "node:crypto";
import { CollectorWireContract, type CollectorCredentialRecord } from "@tracerelic/collector/wire-contract";

export type CollectorScope = Pick<CollectorCredentialRecord, "workspaceId" | "installationId">;

function expiryMillis(timestamp: string): number {
  const leap = timestamp.slice(17, 19) === "60";
  const normalized = leap ? timestamp.slice(0, 17) + "59" + timestamp.slice(19) : timestamp;
  // Date.now() reports integer milliseconds. A fractional expiry stays valid through its preceding millisecond.
  return Date.parse(normalized) + (leap ? 1000 : 0) + (/\.\d{3}\d*[1-9]/.test(timestamp) ? 1 : 0);
}

export class CollectorCredentials {
  private readonly records = new Map<string, CollectorScope & { expires: number }>();

  constructor(records: unknown, private readonly now: () => number = Date.now) {
    if (!Array.isArray(records)) throw new Error("Expected an array of collector credentials");
    const contract = new CollectorWireContract();
    for (const [index, record] of records.entries()) {
      if (!contract.is("CollectorCredentialRecord", record)) throw new Error(`Invalid collector credential at index ${index}`);
      const { tokenSha256, workspaceId, installationId, expiresAt } = record;
      const expires = expiryMillis(expiresAt);
      if (!Number.isFinite(expires)) throw new Error(`Invalid collector credential expiry at index ${index}`);
      if (this.records.has(tokenSha256)) throw new Error(`Duplicate collector credential at index ${index}`);
      this.records.set(tokenSha256, { workspaceId, installationId, expires });
    }
  }

  verify(authorization: string | undefined): CollectorScope | null {
    const match = authorization && /^[ \t]*Bearer +([a-z0-9._~+/-]+=*)[ \t]*$/i.exec(authorization);
    if (!match) return null;
    const hash = createHash("sha256").update(match[1]).digest("hex");
    const record = this.records.get(hash);
    if (!record || !(this.now() < record.expires)) return null;
    return { workspaceId: record.workspaceId, installationId: record.installationId };
  }
}
