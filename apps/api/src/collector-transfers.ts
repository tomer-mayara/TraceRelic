import { isDeepStrictEqual } from "node:util";
import { batchPartBytes, decodeBase64, fitsWireRecords, legacyScannerLocation, legacyScannerStream, stateBytes, unpackBatch, wireDigest,
  type BatchPart, type CollectorWireContract, type PackedBatch } from "@tracerelic/collector/wire-contract";
import type { AcknowledgedSource, Batch, CollectorStorage, SessionKey, SourceLocation, StreamKey } from "@tracerelic/collector/storage";
import type { CollectorScope } from "./collector-credentials.ts";

export interface CollectorWireState {
  putPart(scope: CollectorScope, upload: string, index: number, data: Buffer): Promise<boolean>;
  parts(scope: CollectorScope, upload: string, count: number): Promise<Buffer[] | undefined>;
  discardParts(scope: CollectorScope, upload: string): Promise<void>;
}

/** The loopback API can run against an injected in-memory workspace. */
export class MemoryWireState implements CollectorWireState {
  private readonly uploads = new Map<string, { expires: number; parts: Map<number, Buffer> }>();

  private id(scope: CollectorScope, ...keys: string[]) { return JSON.stringify([scope.workspaceId, scope.installationId, ...keys]); }

  async putPart(scope: CollectorScope, upload: string, index: number, data: Buffer) {
    const now = Date.now();
    for (const [id, stage] of this.uploads) if (stage.expires < now) this.uploads.delete(id);
    const key = this.id(scope, upload);
    const stage = this.uploads.get(key) ?? { expires: now, parts: new Map<number, Buffer>() };
    const prior = stage.parts.get(index);
    if (prior && !prior.equals(data)) return false;
    stage.expires = now + 86_400_000;
    stage.parts.set(index, data);
    this.uploads.set(key, stage);
    return true;
  }

  async parts(scope: CollectorScope, upload: string, count: number) {
    const stage = this.uploads.get(this.id(scope, upload));
    if (!stage || stage.expires < Date.now() || stage.parts.size !== count) return;
    return Array.from({ length: count }, (_, i) => stage.parts.get(i) ?? Buffer.alloc(0));
  }
  async discardParts(scope: CollectorScope, upload: string) { this.uploads.delete(this.id(scope, upload)); }
}

export class CollectorTransfers {
  constructor(readonly state: CollectorWireState, private readonly contract: CollectorWireContract) {}

  async stage(scope: CollectorScope, part: BatchPart): Promise<boolean> {
    let data: Buffer;
    try { data = decodeBase64(part.data); } catch { return false; }
    return data.length > 0 && data.length <= batchPartBytes && this.state.putPart(scope, part.upload, part.index, data);
  }

  async decode(scope: CollectorScope, header: PackedBatch, storage: CollectorStorage): Promise<Batch | "invalid" | "conflict"> {
    if ((header.parts === undefined) === (header.inline === undefined)) return "invalid";
    const source = { ...header.source, installationId: scope.installationId };
    const snapshot = await storage.readCheckpoint(source);
    if (header.expectedVersion !== snapshot.version) return "conflict";
    const base = header.base && stateBytes(snapshot.checkpoint?.parserState);
    if (base && wireDigest(base) !== header.base) return "conflict";
    let fragments: Buffer[] | undefined;
    if (header.parts !== undefined) {
      fragments = await this.state.parts(scope, header.upload, header.parts);
      if (!fragments?.length) return (await storage.readCheckpoint(source)).version === header.expectedVersion ? "invalid" : "conflict";
      const last = fragments.length - 1;
      if (fragments.some((part, i) => !part.length || (i < last && part.length !== batchPartBytes))) return "invalid";
    }
    try {
      const bytes = fragments ? Buffer.concat(fragments) : decodeBase64(header.inline ?? "");
      if (wireDigest(bytes) !== header.upload) return "invalid";
      const batch = unpackBatch(bytes, header, base || undefined);
      if (!this.contract.is("Batch", batch) || !fitsWireRecords(batch) || batch.expectedVersion !== header.expectedVersion
          || !isDeepStrictEqual(batch.source, header.source)) return "invalid";
      return batch;
    } catch { return "invalid"; }
  }

  async resolve(scope: CollectorScope, source: StreamKey, storage: CollectorStorage, location?: SourceLocation): Promise<StreamKey> {
    const key = { ...source, installationId: scope.installationId };
    const legacy = location && legacyScannerStream(source.harness, location);
    if (legacy && (source.streamId === legacy || source.streamId === location.path)) {
      const rows = await storage.listSources({ harness: key.harness, installationId: scope.installationId, root: location.root, sessionIds: [key.sessionId] });
      if (rows.length > 1) await this.sources(storage, rows);
    }
    const canonical = await storage.canonicalSource?.(key);
    return canonical === undefined ? key : { ...key, streamId: canonical };
  }

  async session(scope: CollectorScope, storage: CollectorStorage, key: SessionKey) {
    const session = await storage.readSession(key);
    const rows = session?.missingSources;
    if (!rows || rows.length < 2) return session;
    const roots = new Set<string>();
    for (const row of rows) {
      if (row.source.installationId !== scope.installationId) continue;
      const where = legacyScannerLocation(key.harness, row.source.streamId);
      if (!where || !rows.some(peer => peer.source.installationId === scope.installationId && peer.source.streamId === where.path)) continue;
      roots.add(where.root);
    }
    let changed = false;
    for (const root of roots) {
      const sources = await storage.listSources({ harness: key.harness, installationId: scope.installationId, root, sessionIds: [key.sessionId] });
      const remaining = await this.sources(storage, sources);
      if (remaining.length < sources.length) changed = true;
    }
    return changed ? storage.readSession(key) : session;
  }

  async sources(storage: CollectorStorage, rows: AcknowledgedSource[]): Promise<AcknowledgedSource[]> {
    const byId = new Map(rows.map(row => [JSON.stringify([row.source.sessionId, row.source.streamId]), row]));
    const selected: AcknowledgedSource[] = [];
    for (const row of rows) {
      const legacy = legacyScannerStream(row.source.harness, row.location);
      const peer = byId.get(JSON.stringify([row.source.sessionId, row.location.path]));
      if (row.source.streamId === legacy && peer && peer !== row && row.presence === peer.presence
          && await storage.mergeSourceAlias?.(row.source, peer.source.streamId, row.version)) continue;
      selected.push(row);
    }
    return selected;
  }
}
