import type { LocalHistoryEntry } from "@tracerelic/collector/history";
import type { ClaudeHistory, ClaudeTranscriptEntry, CodexHistory, CodexRolloutEntry, CodexSelection } from "@tracerelic/collector/providers";
import type { ReadPosition, ScanSelection, TranscriptEntry, TranscriptSource } from "@tracerelic/collector/transcript";

interface Transcript<Entry> {
  readonly sessionId: string;
  readonly sourceFile: string;
  readonly endOffset: number;
  readonly entries: readonly Entry[];
}

export type CodexRollout = Transcript<CodexRolloutEntry>;

export interface ClaudeTranscript extends Transcript<ClaudeTranscriptEntry> {
  readonly previousCopy: boolean;
}

const beginning: ReadPosition = { offset: 0, lineNumber: 0 };

/** Reads each selected session of a provider as one transcript, from the start of its file. */
export class TranscriptSnapshots {
  static async *rollouts(reader: CodexHistory, selection: CodexSelection = {}): AsyncGenerator<CodexRollout> {
    for await (const source of reader.discoverSources(selection)) {
      const rollout = await TranscriptSnapshots.snapshot(source);
      if (rollout) yield rollout;
    }
  }

  static async *transcripts(reader: ClaudeHistory, selection: ScanSelection = {}): AsyncGenerator<ClaudeTranscript> {
    for await (const source of reader.discoverSources(selection)) {
      const transcript = await TranscriptSnapshots.snapshot(source);
      if (transcript) yield { ...transcript, previousCopy: source.previousCopy };
    }
  }

  private static async snapshot<H extends LocalHistoryEntry["harness"]>(
    source: TranscriptSource<TranscriptEntry<H>>,
  ): Promise<Transcript<TranscriptEntry<H>> | undefined> {
    const entries: TranscriptEntry<H>[] = [];
    for await (const batch of source.readBatches(beginning)) {
      for (const { startOffset: _startOffset, afterBlankPrefix: _afterBlankPrefix, recordPrefixDigest: _digest, ...entry } of batch.entries) entries.push(entry);
    }
    const last = entries.at(-1);
    if (last) return { sessionId: source.sessionId, sourceFile: source.sourceFile, entries, endOffset: last.endOffset };
  }
}
