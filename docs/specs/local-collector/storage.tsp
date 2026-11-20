import "@typespec/json-schema";
import "./session-key.tsp";
using TypeSpec.JsonSchema;

@jsonSchema
namespace TraceRelic.Collector;

@minValue(0)
@maxValue(9007199254740991)
scalar Count extends integer;

@minValue(1)
scalar Revision extends Count;

@minValue(1)
scalar SourceOrder extends Count;

union Role { "user", "assistant" }
union Coverage { "unknown", "partial", "reported" }
union CommitResult { "committed", "conflict", "invalid" }

model StreamKey extends SessionKey {
  streamId: Identifier;
  /** Stable collector installation when set in the configuration. */
  installationId?: Identifier;
}

model Checkpoint {
  offset: Count;
  parserState: string;
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

union UsageDiagnosticCode { "invalid-claude-usage", "unidentified-claude-call", "unsupported-claude-cache-breakdown", "unsupported-claude-iteration" }

model UsageDiagnostic {
  code: UsageDiagnosticCode;
  sourceOrder: SourceOrder;
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
  parts: Usage[];
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
  hasGap?: boolean;
}

model SessionView {
  key: SessionKey;
  metadata: Metadata;
  messages: Message[];
  usage: Usage[];
  /** Report a source and line once per diagnostic code. */
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
