import { isDeepStrictEqual } from "node:util";
import { LegacyScannerSource, type Checkpoint, type CodexIdentityProof, type CodexIdentityStatus, type PresenceWrite, type SourceLocation, type StreamKey } from "../collector-storage.ts";
import type { SessionMessages } from "../session-messages.ts";
import type { StoredSource } from "../source-inventory.ts";
import { BatchValues } from "../batch-values.ts";

interface Location {
  file?: StoredSource;
  messages: SessionMessages;
  stream: string;
  version: number;
}
interface Correction { status?: CodexIdentityStatus; messages?: SessionMessages; advancePeer?: string }
type Verified = Extract<CodexIdentityProof, { status: "verified" }>;

/** The Codex identity proof of a presence write, and the correction that the proof gives. */
export class CodexSourceIdentity {
  private static matchesCheckpoint(value: unknown, checkpoint: Checkpoint): boolean {
    return BatchValues.isRecord(value) && !!checkpoint.prefixDigest && value.offset === checkpoint.offset && value.prefixDigest === checkpoint.prefixDigest;
  }

  private static validHeader(proof: Verified, update: PresenceWrite, old: Checkpoint): boolean {
    return BatchValues.isIdentifier(proof.peerSessionId) && proof.peerSessionId !== update.source.sessionId && BatchValues.isIdentifier(proof.peerStreamId)
      && BatchValues.isCount(proof.expectedPeerVersion) && BatchValues.isCount(proof.headerEnd) && proof.headerEnd > 0 && proof.headerEnd <= old.offset
      && CodexSourceIdentity.matchesCheckpoint(proof.accepted, old);
  }

  private static originalIdentityStatus(update: PresenceWrite, origin: Location & { file: StoredSource }) {
    const original = origin.file.selected(undefined, origin.version);
    if (update.source.harness !== "codex" || !original || !LegacyScannerSource.needsHistoryVerification(update.source, origin.file.checkpoint, original.location) || original.presence !== update.presence
      || !isDeepStrictEqual(update.location, original.location) || update.observedEnd !== original.observedEnd
      || update.observedPrefixDigest !== original.observedPrefixDigest || update.checkedPrefix !== undefined) return;
    return original.codexIdentityStatus ?? "unverified";
  }

  private static matchesPeer(file: StoredSource, proof: Verified, location: SourceLocation): boolean {
    const checkpoint = file.checkpoint;
    const where = file.selected(undefined, proof.expectedPeerVersion)?.location;
    if (!checkpoint.evidenceVersion || where?.root !== location.root || where.path !== location.path || !CodexSourceIdentity.matchesCheckpoint(proof.peer, checkpoint)) return false;
    return checkpoint.offset > proof.accepted.offset || (checkpoint.offset === proof.accepted.offset && checkpoint.prefixDigest === proof.accepted.prefixDigest);
  }

  /** Validate both durable generations before staging any message or version change. */
  static correction(update: PresenceWrite, origin: Location & { file: StoredSource },
    lookup: (key: StreamKey) => Location | undefined): Correction | "invalid" | "conflict" {
    const proof = update.codexIdentity;
    if (proof === undefined) return {};
    const status = CodexSourceIdentity.originalIdentityStatus(update, origin);
    if (!status || !BatchValues.isRecord(proof)) return "invalid";
    const uncertain = { status };
    if (proof.status === "unverified") return uncertain;
    const through = LegacyScannerSource.line(origin.file.checkpoint);
    if (through === undefined || proof.status !== "verified" || !CodexSourceIdentity.validHeader(proof, update, origin.file.checkpoint)) return "invalid";
    const peer = lookup({ ...update.source, sessionId: proof.peerSessionId, streamId: proof.peerStreamId });
    if (!peer || peer.version !== proof.expectedPeerVersion) return "conflict";
    if (!peer.file || !CodexSourceIdentity.matchesPeer(peer.file, proof, update.location)) return "invalid";
    const messages = origin.messages.withoutCorroborated({ stream: origin.stream, generation: origin.file.generation }, through,
      { messages: peer.messages, stream: peer.stream, generation: peer.file.generation });
    return messages ? { status: origin.file.repairedMessagesStatus, messages, advancePeer: proof.peerSessionId } : uncertain;
  }
}
