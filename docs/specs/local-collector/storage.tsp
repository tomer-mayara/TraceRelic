import "@typespec/json-schema";
using TypeSpec.JsonSchema;

@jsonSchema
namespace TraceRelic.Collector;

@minLength(1)
scalar Identifier extends string;

@minValue(0)
@maxValue(9007199254740991)
scalar Count extends integer;

@minValue(1)
scalar Revision extends Count;

union Harness { "codex", "claude" }
union Role { "user", "assistant" }
union Coverage { "unknown", "partial", "reported" }
union CommitResult { "committed", "conflict", "invalid" }

model SessionKey {
  harness: Harness;
  sessionId: Identifier;
}

model StreamKey extends SessionKey {
  streamId: Identifier;
}

model Checkpoint {
  offset: Count;
  parserState: string;
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
  expectedOffset: Count;
  checkpoint: Checkpoint;
  metadata?: Metadata;
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
  readCheckpoint(source: StreamKey): Checkpoint | null;
  commit(batch: Batch): CommitResult;
  readSession(key: SessionKey): SessionView | null;
}
