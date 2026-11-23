import type { CodexRolloutSource } from "../index.ts";
import { TranscriptChangedError } from "../../transcript/index.ts";
import { LegacyScannerSource, StreamKeys, type AcknowledgedSource, type Checkpoint, type CodexIdentityProof, type CollectorStorage,
  type SourceScope, type StreamKey } from "../../storage/collector-storage.ts";
import { ScanPendingError } from "../../scan/scan-pending.ts";
import { CheckpointProof } from "../../scan/checkpoint-proof.ts";
import { ScanRecovery } from "../../scan/scan-recovery.ts";
import type { SourceSighting } from "../../scan/source-sightings.ts";

interface Seen { sighting: SourceSighting; transcript: CodexRolloutSource }
type IdentitiesAt = (paths: ReadonlySet<string>) => AsyncIterable<{ path: string; sessionId: string }>;

/** A filename only selects candidates. Both accepted checkpoints must match one sealed native capture. */
export class CodexIdentityRepair {
  constructor(private readonly storage: CollectorStorage, private readonly scope: SourceScope) {}

  async reconcile(known: ReadonlyMap<string, AcknowledgedSource>, seen: Iterable<Seen>, identitiesAt?: IdentitiesAt) {
    const peers = new Map<string, Seen[]>();
    for (const other of seen) {
      const path = other.sighting.observation.location.path;
      const located = peers.get(path) ?? [];
      located.push(other);
      peers.set(path, located);
    }
    const rows = [...known.values()].filter(row => row.acceptedOffset > 0 && (!row.codexIdentityStatus || row.codexIdentityStatus === "unverified"));
    const outside = new Map<string, Set<string>>();
    if (identitiesAt && (this.scope.sessionIds?.length || this.scope.projectPaths?.length)) {
      const paths = new Set(rows.map(row => row.location.path).filter(path => !peers.has(path)));
      if (paths.size) for await (const { path, sessionId } of identitiesAt(paths)) {
        const ids = outside.get(path) ?? new Set<string>();
        ids.add(sessionId);
        outside.set(path, ids);
      }
    }
    const selected = new Map([...known].filter(([, row]) => row.codexIdentityStatus === "unverified" || row.codexIdentityStatus === "messages-repaired")
      .map(([id, row]) => [id, row.source]));
    for (const row of rows) {
      const candidates = peers.get(row.location.path) ?? [];
      const otherIds = outside.get(row.location.path);
      if (!candidates.length && (!otherIds?.size || otherIds.has(row.source.sessionId))) continue;
      if (await this.repair(row, candidates)) selected.set(StreamKeys.sourceId(row.source), row.source);
    }
    return [...selected.values()];
  }

  private async repair(row: AcknowledgedSource, candidates: Seen[]) {
    const storage = this.storage;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { checkpoint, version } = await ScanRecovery.read(row.source, () => storage.readCheckpoint(row.source));
      if (!checkpoint || !LegacyScannerSource.needsHistoryVerification(row.source, checkpoint, row.location) || row.codexIdentityStatus === "repaired" || row.codexIdentityStatus === "messages-repaired") return false;
      if (version !== row.version) {
        const fresh = await this.reload(row.source);
        if (!fresh) return false;
        row = fresh;
        continue;
      }
      const proven: CodexIdentityProof[] = [];
      for (const candidate of candidates) {
        const proof = await this.proof(checkpoint, candidate);
        if (proof) proven.push(proof);
      }
      const codexIdentity = proven.length === 1 ? proven[0] : { status: "unverified" } as const;
      if (codexIdentity.status === "unverified" && row.codexIdentityStatus === "unverified") return false;
      const update = { source: row.source, location: row.location, observedEnd: row.observedEnd, observedPrefixDigest: row.observedPrefixDigest,
        presence: row.presence, expectedVersion: version, expectedOffset: checkpoint.offset, codexIdentity };
      try {
        const result = await ScanRecovery.read(row.source, () => storage.recordPresence(update));
        if (result === "committed") return true;
        if (result === "invalid") throw new Error("Storage rejected Codex source identity evidence");
      } catch (error) {
        if (!(error instanceof ScanPendingError)) throw error;
        const durable = await this.reload(row.source);
        if (durable && durable.version > version && durable.codexIdentityStatus && durable.codexIdentityStatus !== row.codexIdentityStatus) return true;
        if (durable && !attempt) { row = durable; continue; }
        throw error;
      }
      const fresh = await this.reload(row.source);
      if (!fresh) return false;
      row = fresh;
    }
    throw new ScanPendingError("version-conflict", row.source);
  }

  private reload(source: StreamKey) {
    return ScanRecovery.read(source, async () => (await this.storage.listSources({ ...this.scope, sessionIds: [source.sessionId], projectPaths: [] }))
      .find(row => StreamKeys.sourceId(row.source) === StreamKeys.sourceId(source)));
  }

  private async proof(old: Checkpoint, { sighting, transcript }: Seen): Promise<CodexIdentityProof | undefined> {
    const headerEnd = transcript.codexHeaderEnd;
    if (sighting.rejected || !old.prefixDigest || !headerEnd || headerEnd > old.offset || LegacyScannerSource.line(old) === undefined) return;
    const { checkpoint, version } = await ScanRecovery.read(sighting.source, () => this.storage.readCheckpoint(sighting.source));
    if (!checkpoint?.evidenceVersion || !checkpoint.prefixDigest || checkpoint.offset < old.offset) return;
    try {
      if (!await CheckpointProof.capture(transcript, old) || !await CheckpointProof.capture(transcript, checkpoint)) return;
    } catch (error) {
      if (error instanceof TranscriptChangedError) return;
      throw error;
    }
    return { status: "verified", headerEnd, peerSessionId: sighting.source.sessionId, peerStreamId: sighting.source.streamId, expectedPeerVersion: version,
      accepted: { offset: old.offset, prefixDigest: old.prefixDigest }, peer: { offset: checkpoint.offset, prefixDigest: checkpoint.prefixDigest } };
  }
}
