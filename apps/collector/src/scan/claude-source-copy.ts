import { join } from "node:path";
import type { ClaudeTranscriptEntry } from "../providers/index.ts";
import { TranscriptChangedError, type TranscriptSource } from "../transcript/index.ts";
import type { AcknowledgedSource, Checkpoint, ObservedExtent, SourceLocation } from "../storage/collector-storage.ts";
import { captureProof, checkpointPrefixes, verifiedCheckpoint } from "./scan-recovery.ts";

type ClaudeSource = TranscriptSource<ClaudeTranscriptEntry>;

export interface ClaudeBackup<Entry> { currentPath: string; path: string; sources: TranscriptSource<Entry>[] }
interface Candidate<Entry> { transcript: TranscriptSource<Entry>; path: string; end: number; suffix: "matches" | "unknown" | "differs" }

export function unreadableCopy(error: unknown): boolean {
  return error instanceof TranscriptChangedError || (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM"));
}

async function compareCopy<Entry>(copy: ClaudeBackup<Entry>, sessionId: string, checkpoint: Checkpoint | null,
  wanted: ObservedExtent): Promise<Candidate<Entry> | false | undefined> {
  if (!copy.sources.length) return;
  const transcript = copy.sources.find(source => source.sessionId === sessionId);
  if (!transcript) return false;
  if (!checkpoint?.prefixDigest) return;
  const end = await transcript.completeEnd();
  const offsets = new Set(checkpointPrefixes(checkpoint).map(prefix => prefix.offset));
  if ([...offsets].some(offset => offset > end)) return false;
  if (wanted.prefixDigest && wanted.offset <= end) offsets.add(wanted.offset);
  const prefixes = await transcript.prefixDigests([...offsets]);
  const digests = new Map(prefixes.map(prefix => [prefix.offset, prefix.prefixDigest]));
  if (!verifiedCheckpoint(checkpoint, digests)) return false;
  const digest = digests.get(wanted.offset);
  const suffix = digest && wanted.prefixDigest ? digest === wanted.prefixDigest ? "matches" : "differs" : "unknown";
  return { transcript, path: copy.path, end, suffix };
}

function through<Entry>(source: TranscriptSource<Entry>, end: number): TranscriptSource<Entry> {
  return { ...source, fileSize: end, completeEnd: async () => end,
    readBatches: (position, size, limit = end) => source.readBatches(position, size, Math.min(limit, end)) };
}

/** Resume only the common, proved bytes when equally plausible copies disagree. */
export async function assessClaudeCopies<Entry>(row: AcknowledgedSource, checkpoint: Checkpoint | null, copies: ClaudeBackup<Entry>[]) {
  const excluded: string[] = [];
  const candidates: Candidate<Entry>[] = [];
  const wanted = row.unrecovered ?? { offset: row.observedEnd, prefixDigest: row.observedPrefixDigest };
  for (const copy of copies) {
    try {
      const candidate = await compareCopy(copy, row.source.sessionId, checkpoint, wanted);
      if (candidate === false) excluded.push(copy.path);
      else if (candidate) candidates.push(candidate);
    } catch (error) {
      if (!unreadableCopy(error)) throw error;
    }
  }
  const rank = { matches: 2, unknown: 1, differs: 0 };
  candidates.sort((a, b) => rank[b.suffix] - rank[a.suffix] || b.end - a.end);
  const best = candidates[0];
  if (!best || !checkpoint) return { excluded, candidates };
  const choices = candidates.filter(candidate => candidate.suffix === best.suffix);
  const accepted = Math.max(...checkpointPrefixes(checkpoint).map(prefix => prefix.offset));
  let limit = best.suffix === "differs" ? accepted : undefined;
  for (const alternative of choices.slice(1)) {
    const offset = Math.min(best.end, alternative.end);
    try {
      const [left, right] = await Promise.all([best.transcript.prefixDigests([offset]), alternative.transcript.prefixDigests([offset])]);
      if (left[0].prefixDigest === right[0].prefixDigest) continue;
    } catch (error) {
      if (!unreadableCopy(error)) throw error;
    }
    limit = Math.max(accepted, best.suffix === "matches" ? wanted.offset : 0);
    break;
  }
  if (limit !== undefined) for (const choice of choices) choice.transcript = through(choice.transcript, limit);
  return { excluded, candidates: choices };
}

/** A named earlier file can resume the logical current stream only from verified bytes. */
export class ClaudeSourceCopy {
  constructor(private readonly copy: ClaudeSource) {}

  async verify(checkpoint: Checkpoint | null): Promise<Map<number, string> | undefined> {
    if (!checkpoint?.offset || !checkpoint.prefixDigest) return;
    return captureProof(this.copy, checkpoint);
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
