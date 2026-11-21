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
  /** Only the child's own native Codex header supplies this link. */
  codexForkHeader?: CodexForkHeader;
  /** End of the first valid native Codex header in the sealed prefix. */
  codexHeaderEnd?: Count;
  /** Native parent and agent of a selected Claude subagent transcript. */
  claudeSubagent?: ClaudeSubagent;
  /** First working directory used for project selection, when available. */
  selectionCwd?: string;
  /** Exact Claude transcript project directory, when available. */
  projectDir?: string;
  /** A distinct working directory inherited from the current Claude transcript. */
  currentFileCwd?: string;
  /** For a named earlier Claude copy, the current transcript path relative to the configured root. */
  currentFilePath?: Identifier;
}

model ClaudeSubagent {
  parentSessionId: Identifier;
  agentId: Identifier;
}

model CodexForkHeader {
  parentSessionId: Identifier;
  /** Creation time of the child thread, when recorded. */
  forkedAt?: utcDateTime;
}

model ScannedEntry<Entry extends {}> {
  ...Entry;
  /** Inclusive byte position of this complete physical record. */
  startOffset: Count;
  /** For conversation records, identifies this exact occurrence across verified file copies. */
  recordPrefixDigest?: PrefixDigest;
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

/** Start at zero or a saved next position. Read within the captured logical file size.
 * Selection, logical bytes and their SHA-256 proof belong to one capture.
 * A true append leaves that extent unchanged; an in-place rewrite invalidates the capture.
 * Plain and Zstandard Codex representations use the same uncompressed offsets and hashes.
 * A record larger than the batch budget occupies its own batch. If the file is
 * replaced or truncated during reading, report the source path and discard the pending batch. */
interface SourceBatches<Entry extends {}> {
  /** Byte immediately after the last newline within the captured file, or zero. */
  completeEnd(): Count;
  /** Hash the captured file through the requested byte positions in one streaming pass. */
  prefixDigests(offsets: Count[]): VerifiedPrefix[];
  readBatches(position: ReadPosition, maxBatchBytes?: SourceOrder, endOffset?: Count): RecordBatch<Entry>[];
}

interface LocalLLMHistoryCodex extends LocalLLMHistory {
  /** Check rollout basenames in the active and archive directories of an accessible root. */
  confirmedAbsent(paths: Identifier[]): Identifier[];
  discoverSources(selection?: ScanSelection): TranscriptSourceInfo[];
  /** Yield one selected rollout at a time. Preserve undated metadata and source order. */
  readRollouts(selection?: ScanSelection): CodexRollout[];
}

interface LocalLLMHistoryClaude extends LocalLLMHistory {
  /** Ignore a backup's current-name alias only when its identity or accepted prefix has been disproved. */
  confirmedAbsent(paths: Identifier[], excludedCopyPaths?: Identifier[]): Identifier[];
  /** Identify every readable session in backups of the acknowledged relative paths. */
  recoveryCandidates(paths: Identifier[]): ClaudeRecoveryCandidate[];
  discoverSources(selection?: ScanSelection): TranscriptSourceInfo[];
  /** Yield complete records grouped by file and effective session ID.
   * Include earlier copies of a selected file for the same session.
   * An omitted Claude root yields no transcripts. */
  readTranscripts(selection?: ScanSelection): ClaudeTranscript[];
}

model ClaudeRecoveryCandidate {
  currentPath: Identifier;
  path: Identifier;
  sources: TranscriptSourceInfo[];
}

/** A scan could not confirm its work. The CLI writes this JSON as a WARN message on stderr.
 * An explicit new scan can retry immediately. */
@TypeSpec.JsonSchema.extension("oneOf", #[#{ required: #["source"] }, #{ required: #["scope"] }])
@TypeSpec.JsonSchema.extension("dependentSchemas", #{
  scope: #{ `not`: #{ required: #["byteRange"] }, properties: #{ reason: #{ `enum`: #["storage-unavailable", "source-changed"] } } }
})
model PendingScan {
  status: "pending";
  reason: "storage-unavailable" | "version-conflict" | "source-changed";
  /** Local capture still changing after a bounded rediscovery. */
  sourceFile?: Identifier;
  source?: StreamKey;
  /** The selected inventory is unavailable before a particular source can be identified. */
  scope?: SourceScope;
  /** Attempted transcript bytes, when a batch was available. */
  byteRange?: ByteRange;
  /** Earliest suggested time for an automatic retry. Honor a longer HTTP Retry-After delay. */
  retryAt: utcDateTime;
}

/** Storage rejected this batch as invalid. The CLI writes this JSON as an ERROR message on stderr.
 * The range describes the attempted bytes. */
model RejectedBatch {
  status: "rejected";
  source: StreamKey;
  byteRange: ByteRange;
}

/** The scan finished the other selected files. Sessions contain only data accepted by storage. */
model RejectedScan {
  sessions: SessionView[];
  @minItems(1)
  rejections: RejectedBatch[];
}

/** Milliseconds between scheduled scans. The default is one minute. */
@minValue(1)
@maxValue(2147483647)
scalar ScanIntervalMs extends int32;

model ScheduledScanOptions extends ScanSelection {
  intervalMs?: ScanIntervalMs;
}

/** The CLI writes one JSON object to stdout per pass, including startup and retries. */
@TypeSpec.JsonSchema.extension("if", #{ properties: #{ status: #{ `const`: "pending" } } })
@TypeSpec.JsonSchema.extension("then", #{ required: #["retryAt"] })
@TypeSpec.JsonSchema.extension("else", #{ `not`: #{ required: #["retryAt"] } })
model ScheduledScanReport {
  status: "complete" | "pending" | "rejected" | "failed";
  /** Sessions whose creation storage confirms during this pass, including recovery of a lost reply. */
  newSessions: Count;
  /** Age of the oldest outstanding source or inventory request, or null when none is pending. */
  oldestPendingAgeMs: Count | null;
  retryAt?: utcDateTime;
}

/** The CLI writes this JSON as an ERROR message on stderr for an unexpected scheduled failure. */
model FailedScan {
  status: "failed";
  reason: "scan-failed";
}

interface LocalCollector {
  /** Import complete records into the destination workspace. Return its selected sessions.
   * An unconfirmed write or unresolved version conflict raises a scan error carrying PendingScan.
   * Emit a RejectedBatch for each invalid commit. Stop that file and continue other files.
   * Emit one MissingSource for each newly confirmed disappearance in the selection.
   * The CLI writes that JSON as a WARN message on stderr.
   * After scanning, raise a scan error carrying RejectedScan if any batch was rejected. */
  scanOnce(selection?: ScanSelection): SessionView[];
  /** Run the same import and presence checks for watch without fetching the final conversation views. */
  scanForChanges(selection?: ScanSelection): void;
}
