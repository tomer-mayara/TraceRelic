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

/** Lowercase SHA-256 of the exact bytes from zero to the checkpoint offset. */
@pattern("^[0-9a-f]{64}$")
scalar PrefixDigest extends string;

model VerifiedPrefix {
  offset: Count;
  prefixDigest: PrefixDigest;
}

model Checkpoint {
  offset: Count;
  parserState: string;
  /** Older checkpoints can lack this evidence. After it is saved, each write supplies a digest.
   * A parser-only upgrade at the same byte preserves the accepted digest. */
  prefixDigest?: PrefixDigest;
  /** While a fallback decision depends on bytes beyond this checkpoint, verify those bytes
   * again on restart. Drop this bound once the checkpoint reaches it. */
  replayThrough?: VerifiedPrefix;
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
  "unsupported-codex-usage", "codex-counter-reset"
}

@extension("if", #{ properties: #{ code: #{ `enum`: #["malformed-transcript-line", "unsupported-codex-usage", "codex-counter-reset"] } } })
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

model Batch {
  source: StreamKey;
  expectedVersion: Count;
  expectedOffset: Count;
  checkpoint: Checkpoint;
  metadata?: Metadata;
  /** Position where metadata.branch was recorded. */
  branchObservation?: BranchObservation;
  messages: Message[];
  usage: Usage[];
  /** Compare each whole Claude report with the evidence already stored in this session. */
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

model SessionView {
  key: SessionKey;
  metadata: Metadata;
  messages: Message[];
  usage: Usage[];
  /** Report the source, position and code once. Keep transcript content out of diagnostics. */
  usageDiagnostics?: SourceUsageDiagnostic[];
  coverage: Coverage;
  observedTotalTokens: Count | null;
}

interface CollectorStorage {
  /** Return the current session version even when this source has no checkpoint. */
  readCheckpoint(source: StreamKey): CheckpointSnapshot;
  commit(batch: Batch): CommitResult;
  readSession(key: SessionKey): SessionView | null;
}
