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

model Usage {
  id: Identifier;
  revision: Revision;
  at: utcDateTime;
  `model`?: string;
  inputTokens: Count;
  outputTokens: Count;
  cacheReadTokens?: Count;
  cacheWriteTokens?: Count;
  reasoningTokens?: Count;
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
  hasGap?: boolean;
}

model SessionView {
  key: SessionKey;
  metadata: Metadata;
  messages: Message[];
  usage: Usage[];
  coverage: Coverage;
  observedTotalTokens: Count | null;
}

interface CollectorStorage {
  /** Return the current session version even when this source has no checkpoint. */
  readCheckpoint(source: StreamKey): CheckpointSnapshot;
  commit(batch: Batch): CommitResult;
  readSession(key: SessionKey): SessionView | null;
}
