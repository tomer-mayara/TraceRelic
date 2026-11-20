import { join } from "node:path";
import type { ClaudeTranscriptEntry, TranscriptSource } from "../history/index.ts";
import type { Checkpoint, SourceLocation } from "../storage/collector-storage.ts";
import { checkpointPrefixes, verifiedCheckpoint } from "./scan-recovery.ts";

type ClaudeSource = TranscriptSource<ClaudeTranscriptEntry>;

/** A named earlier file can resume the logical current stream only from verified bytes. */
export class ClaudeSourceCopy {
  constructor(private readonly copy: ClaudeSource) {}

  async verify(checkpoint: Checkpoint | null): Promise<Map<number, string> | undefined> {
    if (!checkpoint?.offset || !checkpoint.prefixDigest) return;
    const offsets = checkpointPrefixes(checkpoint).map(prefix => prefix.offset);
    if (offsets.some(end => end > this.copy.fileSize)) return;
    const verified = await this.copy.prefixDigests(offsets);
    const digests = new Map(verified.map(({ offset, prefixDigest }) => [offset, prefixDigest]));
    if (verifiedCheckpoint(checkpoint, digests)) return digests;
  }

  current(location: SourceLocation): ClaudeSource {
    const copy = this.copy;
    const sourceFile = join(location.root, location.path);
    // Claude uses the source filename in fallback text IDs. Replaying as the current stream preserves those IDs.
    return { ...copy, sourceFile, previousCopy: false, async *readBatches(...args) {
      for await (const batch of copy.readBatches(...args)) {
        yield { ...batch, entries: batch.entries.map(entry => ({ ...entry, sourceFile })) };
      }
    } };
  }
}
