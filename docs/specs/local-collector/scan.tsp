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

/** One session in one captured file, as the scanner reads it. It has no provider field.
 * Each provider declares its own source model. */
model TranscriptSourceInfo {
  ...PickProperties<LocalHistoryEntry, "sessionId" | "sourceFile">;
  /** File size observed at discovery, including any unfinished suffix. */
  fileSize: Count;
}

/** One session in one Codex rollout. */
model CodexRolloutSource extends TranscriptSourceInfo {
  /** First working directory used for project selection, when available. */
  selectionCwd?: string;
  /** End of the first valid native Codex header in the sealed prefix. */
  codexHeaderEnd?: Count;
  /** Only the child's own native Codex header supplies this link. */
  codexForkHeader?: CodexForkHeader;
}

/** One session in one Claude Code transcript file. */
model ClaudeTranscriptSource extends TranscriptSourceInfo {
  /** True for a named earlier copy. An earlier copy can supply additional UUID-backed rows. */
  previousCopy: boolean;
  /** First working directory used for project selection, when available. */
  selectionCwd?: string;
  /** Exact transcript project directory, when available. */
  projectDir?: string;
  /** Native parent and agent of a selected subagent transcript. */
  claudeSubagent?: ClaudeSubagent;
  /** A distinct working directory inherited from the current transcript. */
  currentFileCwd?: string;
  /** For a named earlier copy, the current transcript path relative to the configured root. */
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
  /** For conversation records, identifies this exact occurrence across verified file copies.
   * Each provider names its conversation records. Codex names response_item and event_msg.
   * Claude Code names user and assistant. */
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

/** Where a source is, and its stream ID for a collector that has no installation ID. */
model LocatedSource {
  location: SourceLocation;
  /** The stream ID that contains the provider root. A collector that has an installation ID
   * uses location.path as the stream ID. */
  rootStreamId: Identifier;
}

/** What a discovery receives, in one object. Each operation gives one value, and each one is optional. */
interface SourceDiscoveryOptions {
  /** Discover only this file again. */
  sourceFile(): Identifier;
  /** Receives the error of a file that changes during the discovery. The discovery continues with the next file. */
  onChanged(error: unknown): void;
}

/** A source that a pass captured, with what the scanner observed of it. */
model SeenSource<Source> {
  sighting: {
    source: StreamKey;
    observation: SourceObservation;
    /** True when storage rejected a batch of this source during the pass. */
    rejected: boolean;
  };
  transcript: Source;
}

/** What a provider receives to check the identity of acknowledged sources, in one object.
 * Each operation gives one value. */
interface IdentityInventory<Source> {
  storage(): CollectorStorage;
  /** The scope of this provider in the scan. */
  scope(): SourceScope;
  /** The acknowledged sources of the scope that this pass did not see. Each key is the JSON text of a stream key. */
  known(): Record<AcknowledgedSource>;
  /** The sources that this pass captured. Read them one time. */
  seen(): SeenSource<Source>[];
}

/** One earlier copy of a current file. */
model EarlierCopy<Source> {
  /** Path of the current file, relative to the provider root. */
  currentPath: Identifier;
  /** Path of the copy, relative to the provider root. */
  path: Identifier;
  /** Each readable session in the copy. */
  sources: Source[];
}

/** A copy that can continue an acknowledged source. */
model CopyCandidate<Source> {
  transcript: Source;
  /** Path of the copy, relative to the provider root. */
  path: Identifier;
}

/** The copies that can continue one acknowledged source, best first, and the copies that cannot. */
model CopyAssessment<Source> {
  /** Paths of the copies whose identity or accepted prefix is disproved. */
  excluded: Identifier[];
  candidates: CopyCandidate<Source>[];
}

/** The checkpoint fields that a provider owns. The scanner writes the other fields. */
model ProviderCheckpointFields {
  ...PickProperties<Checkpoint, "codexFork" | "claudeCallOrigins">;
}

/** The batch fields in which a provider correction names the checkpoint that it replaces. A correction has
 * one of them. The scanner writes resetFrom and repairEvidenceFrom itself. */
model CorrectionBatchFields {
  ...PickProperties<Batch, "reconcileCodexForkFrom" | "backfillClaudeOriginsFrom">;
}

/** The decoder state that a checkpoint saved, with its parser version. */
model SavedDecoder {
  ...PickProperties<ParserCheckpointState, "version" | "decoder">;
}

/** The parser of one source. The provider owns it. It decodes each batch, and it gives the decoder state
 * that a checkpoint saves. This contract does not model its operations. */
interface ChatParser {}

/** One decoded batch, before the scanner adds its source and its checkpoint. A parser gives it.
 * This contract does not model its fields. */
model DecodedChat is Record<unknown>;

/** What UsageCorrection.accepted gives. It has exactly one of the two values. */
interface AcceptedUsage {
  /** The corrected checkpoint. */
  checkpoint(): Checkpoint;
  /** The parser that holds the accepted chat state. The scanner saves the state of that parser in
   * the corrected checkpoint. */
  parser(): ChatParser;
}

/** A provider's plan to classify the accepted usage again at the accepted byte.
 * The scanner reads the accepted bytes again and commits the corrected usage in one batch. */
interface UsageCorrection {
  /** Optional. The parent session, when the provider knows it before the scanner reads the records. */
  parentSessionId(): Identifier;
  /** Receives the saved decoder state of the accepted checkpoint, if it has one, the parser that
   * read the accepted bytes again, and the format of the source. */
  accepted(saved: SavedDecoder | null, reread: ChatParser, format: ParserFormat): AcceptedUsage;
  /** The batch field that names the replaced checkpoint. */
  batchFields(): CorrectionBatchFields;
}

/** The parser format of one source. It has the version of the parser and the operations that make a
 * parser from a saved state. This contract does not model them. It also has the provider rules for the
 * checkpoints of the source. They are the operations here, and each one is optional. */
interface ParserFormat {
  /** The fields that the provider adds to each checkpoint of this source.
   * Codex adds codexFork for a fork. Claude Code adds claudeCallOrigins. */
  checkpointFields(): ProviderCheckpointFields;
  /** Return a correction when the accepted checkpoint does not have what this format records now.
   * Codex returns one when the fork evidence is different from the saved codexFork.
   * Claude Code returns one when a checkpoint beyond byte zero has no claudeCallOrigins. */
  correction(accepted: Checkpoint): UsageCorrection | null;
  /** Only the format of a source that adds to the session of another file has this operation.
   * An earlier Claude Code copy is such a source. Before the first batch of that source, the
   * scanner reads the stored session. The operation receives each decoded batch, the stored
   * session and the accepted offset. Remove from the batch the fields that storage has.
   * Return false to skip the batch. */
  prepareBatch(chat: DecodedChat, known: SessionView | null, expectedOffset: Count): boolean;
}

/** A named earlier file can resume the logical current stream only from verified bytes. */
interface SourceCopy<Source extends TranscriptSourceInfo> {
  /** Return the digests of the accepted prefixes when the copy has the bytes of the checkpoint. */
  verify(checkpoint: Checkpoint | null): VerifiedPrefix[] | null;
  /** The copy with the name and the location of the current stream. */
  current(location: SourceLocation): Source;
  /** The parser of the copy when the scanner reads it as the current stream. */
  format(): ParserFormat;
}

/** The earlier copies of the current files of one provider. An earlier copy can continue an
 * acknowledged source whose current file is absent. */
interface EarlierCopies<Source extends TranscriptSourceInfo> {
  /** Identify every readable session in the copies of the acknowledged relative paths. */
  candidates(paths: Identifier[]): EarlierCopy<Source>[];
  /** Compare the copies of one acknowledged source with its checkpoint and its observed extent.
   * When equally good copies disagree, limit each one to the common, proved bytes. */
  assess(row: AcknowledgedSource, checkpoint: Checkpoint | null, copies: EarlierCopy<Source>[]): CopyAssessment<Source>;
  /** True for an error that shows only that a copy cannot be read. */
  unreadable(error: unknown): boolean;
  /** Read one copy as the current stream. */
  open(copy: Source): SourceCopy<Source>;
}

/** One scan pass of one provider over the selected files. The pass keeps its own state. */
interface ProviderScan<Source extends TranscriptSourceInfo> {
  /** Discover the selected sources. The sources that share one physical file arrive together. */
  discoverFiles(options: SourceDiscoveryOptions): Source[][];
  /** Optional. The name that the physical forms of one file share. */
  logicalName(sourceFile: Identifier): Identifier;
  /** Select the parser for a discovered source and its accepted checkpoint.
   * Use the state of the latest discovery. */
  parserFor(source: Source, checkpoint: Checkpoint | null): ParserFormat;
  /** Give the location of a discovered source and its root-based stream ID. */
  locate(source: Source): LocatedSource;
  /** Search each possible location under an accessible root. Return the paths that are absent. */
  confirmedAbsent(paths: Identifier[], excludedCopyPaths?: Identifier[]): Identifier[];
  /** Optional. Check the identity of the acknowledged sources that this pass did not see.
   * Return the sources that the scan must select. */
  repairIdentities(inventory: IdentityInventory<Source>): StreamKey[];
  /** Optional. Only a provider that keeps earlier copies of a file has this. */
  earlierCopies(): EarlierCopies<Source>;
}

/** The local transcripts of one provider, as the scanner uses them. The scanner knows a provider
 * only through this port. */
interface ScanProvider<Source extends TranscriptSourceInfo> {
  /** The harness of each source that this provider discovers. */
  harness(): Harness;
  /** The provider root, an absolute path. It is the root of each source scope and of each source location. */
  root(): string;
  /** Open one pass over the selected files. An empty selection includes each file of the root. */
  openScan(selection: ScanSelection): ProviderScan<Source>;
}

/** One Codex scan pass. Its state is the fork evidence of the latest discovery. A discovery of one
 * changed file replaces that evidence, with the selected parents as related sources. */
interface CodexScan extends ProviderScan<CodexRolloutSource> {
  /** Give each selected rollout as its own group, as soon as it is discovered.
   * A fork also needs the headers of the later selected files. */
  discoverFiles(options: SourceDiscoveryOptions): CodexRolloutSource[][];
  /** The rollout basename. A plain rollout and its .zst form have the same name. */
  logicalName(sourceFile: Identifier): Identifier;
  /** The path is the logical name. The root-based stream ID is the JSON array of the root and the path. */
  locate(source: CodexRolloutSource): LocatedSource;
  /** Check rollout basenames in the active and archive directories of an accessible root. */
  confirmedAbsent(paths: Identifier[]): Identifier[];
  /** A filename only selects candidates. Both accepted checkpoints must match one sealed native capture.
   * A session-only scan may inspect the native ID at an old location without importing the other chat. */
  repairIdentities(inventory: IdentityInventory<CodexRolloutSource>): StreamKey[];
}

/** The Codex provider. It receives the Codex root directory as an absolute path. */
interface CodexHistory extends HistoryProvider {
  /** A Codex rollout stored as .jsonl.zst has the same logical bytes as its plain form.
   * For same-name plain and compressed copies with the same native ID, return the longer
   * verified byte prefix. Prefer plain on a tie. Read divergent files independently. */
  readHistory(window: HistoryWindow): LocalHistoryEntry[];
  /** "codex" */
  harness(): Harness;
  root(): string;
  openScan(selection: ScanSelection): CodexScan;
  /** Yield one selected rollout at a time. Preserve undated metadata and source order. */
  readRollouts(selection?: ScanSelection): CodexRollout[];
}

/** One Claude Code scan pass. It has no identity repair and no logical name. */
interface ClaudeScan extends ProviderScan<ClaudeTranscriptSource> {
  /** Give all the selected sessions of one physical file as one group. */
  discoverFiles(options: SourceDiscoveryOptions): ClaudeTranscriptSource[][];
  /** The path is relative to the root. The root-based stream ID is the absolute source file. */
  locate(source: ClaudeTranscriptSource): LocatedSource;
  /** Ignore a backup's current-name alias only when its identity or accepted prefix has been disproved. */
  confirmedAbsent(paths: Identifier[], excludedCopyPaths?: Identifier[]): Identifier[];
  earlierCopies(): EarlierCopies<ClaudeTranscriptSource>;
}

/** The Claude Code provider. It receives the Claude Code root directory as an absolute path.
 * A collector with no Claude Code root has no Claude Code provider. */
interface ClaudeHistory extends HistoryProvider {
  /** "claude" */
  harness(): Harness;
  root(): string;
  openScan(selection: ScanSelection): ClaudeScan;
  /** Yield complete records grouped by file and effective session ID.
   * Include earlier copies of a selected file for the same session. */
  readTranscripts(selection?: ScanSelection): ClaudeTranscript[];
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

/** What the scanner receives. Each operation gives one value. Only providers and storage are required. */
interface LocalCollectorOptions {
  /** The scanner reads these providers in this order. A provider that is not configured is not supplied.
   * LocalProviders.fromConfig gives Codex first, then Claude Code when the configuration has a claudePath.
   * Each of these provider objects is a HistoryProvider and a ScanProvider.
   * Supply at most one provider for each harness. With an installation ID, a stream ID does not
   * contain the provider root, so two roots of one harness can give one stream key to two files. */
  providers(): ScanProvider<TranscriptSourceInfo>[];
  /** The destination workspace. */
  storage(): CollectorStorage;
  /** The installation ID of the configuration. Without it, each stream ID is root-based. */
  installationId(): Identifier;
  /** Receives each RejectedBatch. */
  onRejection(report: RejectedBatch): void;
  /** Receives each MissingSource. */
  onMissing(report: MissingSource): void;
  /** The watch schedule supplies its clock and its record of outstanding work. */
  progress(): ScanProgress;
}

/** The scanner tells the watch schedule what storage has confirmed. */
interface ScanProgress {
  /** UTC milliseconds since the Unix epoch. */
  now(): Count;
  /** The scanner matched the durable checkpoint of a source to its capture. It gives the capture
   * when it has one. The schedule reads only the prefix digests of the capture. */
  verified(source: StreamKey, snapshot: CheckpointSnapshot, transcript?: SourceBatches<{}>): void;
  /** The scanner read a source to its end without a rejection. */
  finishedSource(source: StreamKey): void;
}

/** The scanner receives LocalCollectorOptions. It scans the files of each provider in the order
 * of the providers. Then it checks the presence of the sources of each provider in the same order.
 * It returns the sessions of each provider in that order. */
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
