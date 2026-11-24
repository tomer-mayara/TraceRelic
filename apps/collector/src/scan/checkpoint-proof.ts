import { isDeepStrictEqual } from "node:util";
import type { TranscriptSource, VerifiedPrefix } from "../transcript/index.ts";
import type { Checkpoint } from "../storage/collector-storage.ts";

/** The prefix digests of an accepted checkpoint and their check on the bytes of a transcript. The class also compares two checkpoints. */
export class CheckpointProof {
  static prefixes(checkpoint: Checkpoint | null): VerifiedPrefix[] {
    if (!checkpoint?.prefixDigest) return [];
    const accepted = { offset: checkpoint.offset, prefixDigest: checkpoint.prefixDigest };
    const prefixes = checkpoint.replayThrough ? [accepted, checkpoint.replayThrough] : [accepted];
    const fork = checkpoint.codexFork?.inheritedThrough;
    if (fork?.prefixDigest && fork.offset > accepted.offset) prefixes.push({ offset: fork.offset, prefixDigest: fork.prefixDigest });
    return prefixes;
  }

  static verifiedBy(checkpoint: Checkpoint, digests: ReadonlyMap<number, string>): boolean {
    return !!checkpoint.prefixDigest && CheckpointProof.prefixes(checkpoint).every(prefix => digests.get(prefix.offset) === prefix.prefixDigest);
  }

  static async capture(source: Pick<TranscriptSource<unknown>, "fileSize" | "prefixDigests">, checkpoint: Checkpoint | null) {
    if (!checkpoint?.prefixDigest) return;
    const offsets = CheckpointProof.prefixes(checkpoint).map(p => p.offset);
    if (offsets.some(end => end > source.fileSize)) return;
    const prefixes = await source.prefixDigests(offsets);
    const digests = new Map(prefixes.map(p => [p.offset, p.prefixDigest]));
    if (CheckpointProof.verifiedBy(checkpoint, digests)) return digests;
  }

  static same(left: Checkpoint | null, right: Checkpoint | null): boolean {
    if (!left || !right) return left === right;
    return left.offset === right.offset && left.prefixDigest === right.prefixDigest && left.parserState === right.parserState
      && left.evidenceVersion === right.evidenceVersion && left.claudeCallOrigins === right.claudeCallOrigins
      && isDeepStrictEqual(left.replayThrough, right.replayThrough) && isDeepStrictEqual(left.codexFork, right.codexFork);
  }
}
