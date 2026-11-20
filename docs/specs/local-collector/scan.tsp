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
  /** Version 2 adds Codex counter state. Claude checkpoints continue to use version 1. */
  version: 1 | 2;
  lineNumber: SourceOrder;
  decoder: Record<unknown>;
}

model TranscriptSourceInfo {
  ...PickProperties<LocalHistoryEntry, "sessionId" | "sourceFile">;
  /** File size observed at discovery, including any unfinished suffix. */
  fileSize: Count;
  previousCopy: boolean;
}

model RecordBatch<Entry> {
  entries: Entry[];
  next: ReadPosition;
}

model CodexRecordBatch is RecordBatch<CodexRolloutEntry>;
model ClaudeRecordBatch is RecordBatch<ClaudeTranscriptEntry>;

/** Start at zero or a saved next position. Read within the captured file size.
 * A record larger than the batch budget occupies its own batch. If the file is
 * replaced or truncated during reading, report the source path and discard the pending batch. */
interface SourceBatches<Entry> {
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
