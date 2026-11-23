import { join } from "node:path";
import type { ClaudeHistory, ClaudeTranscriptEntry, ClaudeTranscriptSource } from "../index.ts";
import { TranscriptChangedError, type TranscriptSource } from "../../transcript/index.ts";
import type { AcknowledgedSource, Checkpoint, ObservedExtent, SourceLocation } from "../../storage/collector-storage.ts";
import { CheckpointProof } from "../../scan/checkpoint-proof.ts";
import type { CopyAssessment, EarlierCopies, EarlierCopy, SourceCopy } from "../../scan/scan-provider.ts";
import type { ParserFormat } from "../../scan/transcript-cursor.ts";
import { ClaudeSessionParser } from "./claude-session-parser.ts";

type ClaudeSource = ClaudeTranscriptSource;

interface Candidate<Source> { transcript: Source; path: string; end: number; suffix: "matches" | "unknown" | "differs" }

/** A named earlier file can resume the logical current stream only from verified bytes. */
export class ClaudeSourceCopy implements SourceCopy<ClaudeTranscriptEntry, ClaudeSource> {
  constructor(private readonly copy: ClaudeSource) {}

  async verify(checkpoint: Checkpoint | null): Promise<Map<number, string> | undefined> {
    if (!checkpoint?.offset || !checkpoint.prefixDigest) return;
    return CheckpointProof.capture(this.copy, checkpoint);
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

  /** The scanner reads the copy as the current stream. */
  format(): ParserFormat<ClaudeTranscriptEntry> {
    return ClaudeSessionParser.forSource(false, this.copy.claudeSubagent);
  }
}

/** The earlier copies of the current Claude Code transcripts. A copy can continue an absent current file. */
export class ClaudeEarlierCopies implements EarlierCopies<ClaudeTranscriptEntry, ClaudeSource> {
  constructor(private readonly history: Pick<ClaudeHistory, "recoveryCandidates">) {}

  private static async compareCopy<Source extends TranscriptSource<unknown>>(copy: EarlierCopy<Source>, sessionId: string, checkpoint: Checkpoint | null,
    wanted: ObservedExtent): Promise<Candidate<Source> | false | undefined> {
    if (!copy.sources.length) return;
    const transcript = copy.sources.find(source => source.sessionId === sessionId);
    if (!transcript) return false;
    if (!checkpoint?.prefixDigest) return;
    const end = await transcript.completeEnd();
    const offsets = new Set(CheckpointProof.prefixes(checkpoint).map(prefix => prefix.offset));
    if ([...offsets].some(offset => offset > end)) return false;
    if (wanted.prefixDigest && wanted.offset <= end) offsets.add(wanted.offset);
    const prefixes = await transcript.prefixDigests([...offsets]);
    const digests = new Map(prefixes.map(prefix => [prefix.offset, prefix.prefixDigest]));
    if (!CheckpointProof.verifiedBy(checkpoint, digests)) return false;
    const digest = digests.get(wanted.offset);
    const suffix = digest && wanted.prefixDigest ? digest === wanted.prefixDigest ? "matches" : "differs" : "unknown";
    return { transcript, path: copy.path, end, suffix };
  }

  private static through<Source extends TranscriptSource<unknown>>(source: Source, end: number): Source {
    return { ...source, fileSize: end, completeEnd: async () => end,
      readBatches: (position, size, limit = end) => source.readBatches(position, size, Math.min(limit, end)) };
  }

  candidates(paths: ReadonlySet<string>): AsyncIterable<EarlierCopy<ClaudeSource>> {
    return this.history.recoveryCandidates(paths);
  }

  /** Resume only the common, proved bytes when equally plausible copies disagree. */
  async assess(row: AcknowledgedSource, checkpoint: Checkpoint | null, copies: EarlierCopy<ClaudeSource>[]): Promise<CopyAssessment<ClaudeSource>> {
    const excluded: string[] = [];
    const candidates: Candidate<ClaudeSource>[] = [];
    const wanted = row.unrecovered ?? { offset: row.observedEnd, prefixDigest: row.observedPrefixDigest };
    for (const copy of copies) {
      try {
        const candidate = await ClaudeEarlierCopies.compareCopy(copy, row.source.sessionId, checkpoint, wanted);
        if (candidate === false) excluded.push(copy.path);
        else if (candidate) candidates.push(candidate);
      } catch (error) {
        if (!this.unreadable(error)) throw error;
      }
    }
    const rank = { matches: 2, unknown: 1, differs: 0 };
    candidates.sort((a, b) => rank[b.suffix] - rank[a.suffix] || b.end - a.end);
    const best = candidates[0];
    if (!best || !checkpoint) return { excluded, candidates };
    const choices = candidates.filter(candidate => candidate.suffix === best.suffix);
    const accepted = Math.max(...CheckpointProof.prefixes(checkpoint).map(prefix => prefix.offset));
    let limit = best.suffix === "differs" ? accepted : undefined;
    for (const alternative of choices.slice(1)) {
      const offset = Math.min(best.end, alternative.end);
      try {
        const [left, right] = await Promise.all([best.transcript.prefixDigests([offset]), alternative.transcript.prefixDigests([offset])]);
        if (left[0].prefixDigest === right[0].prefixDigest) continue;
      } catch (error) {
        if (!this.unreadable(error)) throw error;
      }
      limit = Math.max(accepted, best.suffix === "matches" ? wanted.offset : 0);
      break;
    }
    if (limit !== undefined) for (const choice of choices) choice.transcript = ClaudeEarlierCopies.through(choice.transcript, limit);
    return { excluded, candidates: choices };
  }

  unreadable(error: unknown): boolean {
    return error instanceof TranscriptChangedError || (error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM"));
  }

  open(copy: ClaudeSource): ClaudeSourceCopy {
    return new ClaudeSourceCopy(copy);
  }
}
