import "./storage.tsp";
import "./history.tsp";

namespace TraceRelic.Collector;

/** An empty selection includes all configured roots. Select a session by its
 * session key's ID, or select its recorded working directory or an ancestor.
 * Claude also accepts the exact projects/<project> transcript directory. */
model ScanSelection {
  sessionIds?: Identifier[];
  projectPaths?: string[];
}

model TranscriptEntry<Provider extends string> {
  ...PickProperties<LocalHistoryEntry, "sessionId" | "sourceFile" | "lineNumber" | "record">;
  ...OptionalProperties<PickProperties<LocalHistoryEntry, "timestamp">>;
  harness: Provider;
  /** Byte position immediately after this record's newline. */
  endOffset: Count;
}

model Transcript<Entry> {
  ...PickProperties<LocalHistoryEntry, "sessionId" | "sourceFile">;
  endOffset: Count;
  entries: Entry[];
}

model CodexRolloutEntry is TranscriptEntry<"codex">;
model CodexRollout is Transcript<CodexRolloutEntry>;
model ClaudeTranscriptEntry is TranscriptEntry<"claude">;

model ClaudeTranscript {
  ...Transcript<ClaudeTranscriptEntry>;
  /** An orphaned or superseded transcript can supply additional UUID-backed rows. */
  previousCopy: boolean;
}

model ReadPosition {
  /** Next unread byte and number of physical lines through this byte. Both start at zero. */
  offset: Count;
  lineNumber: Count;
}

/** JSON stored in Checkpoint.parserState after a batch. The provider owns the decoder fields. */
model ParserCheckpointState {
  /** Version 4 saves a Codex gap while the decoder waits for a reliable baseline.
   * It can also carry the fallback ID reservations introduced in version 3. */
  version: 1 | 2 | 3 | 4;
  /** Zero only at the beginning of an empty source. */
  lineNumber: Count;
  decoder: Record<unknown>;
  /** For each disputed text fingerprint, keep its old ID range and its count in the replacement.
   * These bounds keep later identical appends distinct after a restart. */
  replayOccurrences?: Record<ReplayOccurrences>;
}

model ReplayOccurrences {
  accepted: SourceOrder;
  replayed: Count;
}

model TranscriptSourceInfo {
  ...PickProperties<LocalHistoryEntry, "sessionId" | "sourceFile">;
  /** File size observed at discovery, including any unfinished suffix. */
  fileSize: Count;
  previousCopy: boolean;
}

model ScannedEntry<Entry extends {}> {
  ...Entry;
  /** Inclusive byte position of this complete physical record. */
  startOffset: Count;
  /** A native Codex session header can follow leading blank lines. */
  afterBlankPrefix?: true;
}

model DamagedLine extends ByteRange {
  lineNumber: SourceOrder;
}

model RecordBatch<Entry extends {}> {
  entries: ScannedEntry<Entry>[];
  /** Complete, nonblank lines that could not be read as UTF-8 JSON objects, in source order. */
  damagedLines?: DamagedLine[];
  next: ReadPosition;
  prefixDigest: PrefixDigest;
}

model CodexRecordBatch is RecordBatch<CodexRolloutEntry>;
model ClaudeRecordBatch is RecordBatch<ClaudeTranscriptEntry>;

/** Start at zero or a saved next position. Read within the captured file size.
 * A record larger than the batch budget occupies its own batch. If the file is
 * replaced or truncated during reading, report the source path and discard the pending batch. */
interface SourceBatches<Entry extends {}> {
  /** Hash the captured file through the requested byte positions in one streaming pass. */
  prefixDigests(offsets: Count[]): VerifiedPrefix[];
  readBatches(position: ReadPosition, maxBatchBytes?: SourceOrder, endOffset?: Count): RecordBatch<Entry>[];
}

interface LocalLLMHistoryCodex extends LocalLLMHistory {
  discoverSources(selection?: ScanSelection): TranscriptSourceInfo[];
  /** Yield one selected rollout at a time. Preserve undated metadata and source order. */
  readRollouts(selection?: ScanSelection): CodexRollout[];
}

interface LocalLLMHistoryClaude extends LocalLLMHistory {
  discoverSources(selection?: ScanSelection): TranscriptSourceInfo[];
  /** Yield complete records grouped by file and effective session ID.
   * Include earlier copies of a selected file for the same session.
   * An omitted Claude root yields no transcripts. */
  readTranscripts(selection?: ScanSelection): ClaudeTranscript[];
}

interface LocalCollector {
  /** Import complete records into the destination workspace. Return its selected sessions.
   * A rejected commit reports the source file and attempted byte range. */
  scanOnce(selection?: ScanSelection): SessionView[];
}
