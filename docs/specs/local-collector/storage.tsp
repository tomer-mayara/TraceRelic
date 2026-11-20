import "@typespec/json-schema";
import "./session-key.tsp";
using TypeSpec.JsonSchema;

@jsonSchema
namespace TraceRelic.Collector;

@minValue(0)
@maxValue(9007199254740991)
scalar Count extends integer;

@minValue(1)
scalar PositiveCount extends Count;

scalar Revision extends PositiveCount;

scalar SourceOrder extends PositiveCount;

union Role { "user", "assistant" }
union Coverage { "unknown", "partial", "reported" }
union CommitResult { "committed", "conflict", "invalid" }

model StreamKey extends SessionKey {
  streamId: Identifier;
  /** Stable collector installation when set in the configuration. */
  installationId?: Identifier;
}

/** Information used to match the original discovery selection. */
model SourceLocation {
  root: Identifier;
  /** The Codex rollout basename or the Claude path relative to its configured root. */
  path: Identifier;
  cwd?: Identifier;
  projectDir?: Identifier;
  /** An earlier Claude copy can also be selected through its current file's working directory. */
  currentFileCwd?: Identifier;
}

model SourceObservation {
  location: SourceLocation;
  /** Last newline seen in this captured generation, including bytes beyond this batch. */
  observedEnd: Count;
}

model SourceScope {
  harness: Harness;
  root: Identifier;
  installationId?: Identifier;
  sessionIds?: Identifier[];
  projectPaths?: string[];
}

union SourcePresence { "present", "missing" }

model AcknowledgedSource extends SourceObservation {
  source: StreamKey;
  version: Count;
  acceptedOffset: Count;
  presence: SourcePresence;
}

model PresenceWrite extends SourceObservation {
  source: StreamKey;
  expectedVersion: Count;
  expectedOffset: Count;
  presence: SourcePresence;
}

model MissingSource {
  status: "missing";
  source: StreamKey;
  acceptedOffset: Count;
  observedEnd: Count;
}

/** Lowercase SHA-256 of the exact bytes from zero to the checkpoint offset. */
@pattern("^[0-9a-f]{64}$")
scalar PrefixDigest extends string;

model VerifiedPrefix {
  offset: Count;
  prefixDigest: PrefixDigest;
}

@extension("dependentRequired", #{ claudeCallOrigins: #["prefixDigest"] })
@extension("not", #{ required: #["claudeCallOrigins", "codexFork"] })
model Checkpoint {
  offset: Count;
  parserState: string;
  /** Older checkpoints can lack this evidence. After it is saved, each write supplies a digest.
   * A parser-only upgrade at the same byte preserves the accepted digest. */
  prefixDigest?: PrefixDigest;
  /** While a fallback decision depends on bytes beyond this checkpoint, verify those bytes
   * again on restart. Drop this bound once the checkpoint reaches it. */
  replayThrough?: VerifiedPrefix;
  /** Decision for the captured Codex fork. Older checkpoints lack this field. */
  codexFork?: CodexForkCheckpoint;
  /** The scanner has submitted native Claude call origins through this byte. */
  claudeCallOrigins?: true;
}

model ForkPosition {
  /** Next byte after a verified copy, or the first byte of an uncertain row. */
  offset: Count;
  /** Physical line establishing the boundary or uncertainty. */
  lineNumber: SourceOrder;
}

@extension("dependentRequired", #{ baseline: #["inheritedThrough"] })
@extension("not", #{ required: #["inheritedThrough", "firstUncertain"] })
model CodexForkCheckpoint {
  parentSessionId: Identifier;
  /** Last verified inherited row. A verified empty prefix ends at the child's header. */
  inheritedThrough?: ForkBoundary;
  /** Cumulative counters at that boundary, when available. */
  baseline?: TokenCounts;
  /** Earliest usage whose origin is unresolved. */
  firstUncertain?: ForkPosition;
}

model ForkBoundary extends ForkPosition {
  /** Verify the copied bytes if the scan stopped before this boundary. */
  prefixDigest?: PrefixDigest;
}

model CheckpointSnapshot {
  /** All sources for the session share this version. A new session starts at zero. */
  version: Count;
  checkpoint: Checkpoint | null;
}

model Metadata {
  cwd?: string;
  branch?: string;
  repository?: string;
  parentSessionId?: Identifier;
}

model Message {
  id: Identifier;
  at: utcDateTime;
  role: Role;
  text: string;
  /** One-based record number in the source transcript. */
  sourceOrder?: SourceOrder;
  /** Zero-based position in the original content array. */
  blockIndex?: Count;
  turnId?: Identifier;
  requestId?: Identifier;
  context?: Metadata;
}

model BranchObservation {
  /** Omit the time when the source only establishes record order. */
  at?: utcDateTime;
  sourceOrder: SourceOrder;
}

model TokenCounts {
  inputTokens: Count;
  outputTokens: Count;
  cacheReadTokens?: Count;
  cacheWriteTokens?: Count;
  reasoningTokens?: Count;
}

union UsageKind { "call", "interval" }
union UsageStatus { "provisional", "final" }

model CacheWriteDurations {
  /** Parts of cacheWriteTokens. */
  cacheWrite5mTokens?: Count;
  cacheWrite1hTokens?: Count;
}

/** A whole provider observation. At least one native message or request ID is required.
 * An advisor iteration belongs to the same request and has its own measurement. */
@extension("anyOf", #[#{ required: #["messageId"] }, #{ required: #["requestId"] }])
model ClaudeUsageReport extends TokenCounts {
  ...CacheWriteDurations;
  at: utcDateTime;
  status: UsageStatus;
  messageId?: Identifier;
  requestId?: Identifier;
  turnId?: Identifier;
  `model`?: string;
  iterationId?: Identifier;
  /** Native evidence about the transcript row. Older writers omit it. */
  origin?: ClaudeCallOrigin;
}

union ClaudeOriginKind { "own", "copy", "subagent" }

@extension("dependentRequired", #{ parentMessageUuid: #["parentSessionId"] })
@extension("allOf", #[
  #{ `if`: #{ required: #["parentMessageUuid"] }, then: #{ properties: #{ kind: #{ `const`: "copy" } } } },
  #{ `if`: #{ properties: #{ kind: #{ `const`: "subagent" } } }, then: #{ required: #["parentSessionId"] } }
])
model ClaudeCallOrigin {
  /** A native child call, a marked copy, or a subagent row with uncertain ownership. */
  kind: ClaudeOriginKind;
  transcriptUuid?: Identifier;
  parentSessionId?: Identifier;
  /** Original transcript row identified by forkedFrom.messageUuid. */
  parentMessageUuid?: Identifier;
  sourceOrder: SourceOrder;
  byteRange: ByteRange;
}

/** Zero-based source bytes, from the first byte through the terminating newline.
 * startOffset is inclusive and endOffset is exclusive. */
model ByteRange {
  startOffset: Count;
  endOffset: PositiveCount;
}

union UsageDiagnosticCode {
  "invalid-claude-usage", "unidentified-claude-call", "unsupported-claude-cache-breakdown",
  "unsupported-claude-iteration", "ambiguous-transcript-replay", "malformed-transcript-line",
  "unsupported-codex-usage", "codex-counter-reset", "unresolved-codex-fork", "unresolved-claude-fork"
}

@extension("if", #{ properties: #{ code: #{ `enum`: #["malformed-transcript-line", "unsupported-codex-usage", "codex-counter-reset", "unresolved-codex-fork", "unresolved-claude-fork"] } } })
@extension("then", #{ required: #["byteRange"] })
model UsageDiagnostic {
  code: UsageDiagnosticCode;
  sourceOrder: SourceOrder;
  /** Scans include the exact range. Earlier line-only diagnostics remain readable. */
  byteRange?: ByteRange;
}

model SourceUsageDiagnostic extends UsageDiagnostic {
  streamId: Identifier;
  installationId?: Identifier;
}

model Usage extends TokenCounts {
  ...CacheWriteDurations;
  id: Identifier;
  revision: Revision;
  at: utcDateTime;
  /** A model can be recorded for a call or an older untyped observation. */
  `model`?: string;
  /** Older records can omit the kind. Only a call can identify a turn or request. */
  kind?: UsageKind;
  /** Provider completion status when known. */
  status?: UsageStatus;
  messageId?: Identifier;
  iterationId?: Identifier;
  turnId?: Identifier;
  requestId?: Identifier;
}

/** A single verified progression of cumulative counters. The parts together account
 * for the change in input and output. They can include calls already stored by ID. */
model UsageWindow {
  /** Identifies a native counter history and, after a reset, its new range. */
  historyId: Identifier;
  start: TokenCounts;
  end: TokenCounts;
  /** SHA-256 fingerprints of the native reports at both boundaries in the same verified
   * counter history. A copy can use these to match a range across a hidden reset. */
  boundaryObservations?: BoundaryObservations;
  parts: Usage[];
}

model BoundaryObservations {
  @pattern("^[0-9a-f]{64}$")
  start: string;
  @pattern("^[0-9a-f]{64}$")
  end: string;
}

/** A separately reported call occurred after this source's last known counter.
 * A second copy may already include it inside a coarse interval. */
model UsageAnchor {
  usageId: Identifier;
  historyId: Identifier;
  after?: TokenCounts;
}

@extension("if", #{ properties: #{ checkpoint: #{ type: "object", required: #["claudeCallOrigins"] } } })
@extension("then", #{ properties: #{
  source: #{ type: "object", properties: #{ harness: #{ `const`: "claude" } } },
  claudeUsageReports: #{ type: "array", items: #{ type: "object", required: #["origin"] } }
} })
model Batch {
  source: StreamKey;
  sourceObservation?: SourceObservation;
  expectedVersion: Count;
  expectedOffset: Count;
  checkpoint: Checkpoint;
  metadata?: Metadata;
  /** Position where metadata.branch was recorded. */
  branchObservation?: BranchObservation;
  messages: Message[];
  usage: Usage[];
  /** Bind a reliable native call to its workspace owner. Copied reports can name their verified parent. */
  codexCallClaims?: CodexCallClaim[];
  /** Replace this stream's usage for the verified checkpoint using the new fork evidence.
   * Compare the exact saved checkpoint. Keep messages, other streams and earlier transcript generations. */
  reconcileCodexForkFrom?: Checkpoint;
  /** Submit Claude call origins from a previously accepted prefix. Compare its exact
   * checkpoint and keep its bytes, messages and replay position. */
  backfillClaudeOriginsFrom?: Checkpoint;
  /** Compare each whole Claude report with stored evidence. A checkpoint marked
   * claudeCallOrigins requires origin on every report. */
  claudeUsageReports?: ClaudeUsageReport[];
  usageDiagnostics?: UsageDiagnostic[];
  /** Each anchor refers to a call in this batch's usage list. */
  usageAnchors?: UsageAnchor[];
  /** Storage atomically replaces a coarse interval when a verified, complete
   * partition covers the same counters. Replaying the coarse copy keeps the detail. */
  usageWindows?: UsageWindow[];
  /** Upgrade an accepted text-only checkpoint at the same offset to add usage for its prefix.
   * Supply empty messages and metadata. Compare the exact previous parser state, version and offset. */
  upgradeFromParserState?: string;
  /** Replay from byte zero after a rewrite or truncation. Match the entire accepted checkpoint
   * as well as the session version. Keep accepted records and require a new prefix digest. */
  resetFrom?: Checkpoint;
  hasGap?: boolean;
}

model CodexCallClaim {
  /** SHA-256 of the provider ID and its kind, independent of the reporting session. */
  providerId: PrefixDigest;
  /** Session-scoped ID of the call in the reporting stream. */
  usageId: Identifier;
  ownerSessionId: Identifier;
}

model SessionView {
  key: SessionKey;
  metadata: Metadata;
  messages: Message[];
  usage: Usage[];
  /** Report the source, position and code once. Keep transcript content out of diagnostics. */
  usageDiagnostics?: SourceUsageDiagnostic[];
  /** One entry for each currently missing acknowledged source. */
  missingSources?: MissingSource[];
  coverage: Coverage;
  observedTotalTokens: Count | null;
}

/** A connection failure or timeout can interrupt any operation. For an unconfirmed write,
 * read the acknowledged checkpoint before retrying. A rate limit or temporary HTTP failure
 * defers work until the suggested retry. An invalid credential stops the caller. */
interface CollectorStorage {
  /** Match the installation and configured root exactly. Apply session and project selections as alternatives. */
  listSources(scope: SourceScope): AcknowledgedSource[];
  /** Compare the session version and accepted byte. Preserve the checkpoint and accepted records.
   * A repeat of the current state with the current version succeeds without advancing the version. */
  recordPresence(update: PresenceWrite): CommitResult;
  /** Return the current session version even when this source has no checkpoint. */
  readCheckpoint(source: StreamKey): CheckpointSnapshot;
  /** A lost reply leaves the outcome unknown. Read the durable checkpoint and session version to recover. */
  commit(batch: Batch): CommitResult;
  readSession(key: SessionKey): SessionView | null;
}
