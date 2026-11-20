import type { harnesses } from "@tracerelic/shared";

export type Harness = (typeof harnesses)[number];
export type Identifier = string;
export type Count = number;
export type Revision = Count;
export type SourceOrder = Count;
export type Role = "user" | "assistant";
export type Coverage = "unknown" | "partial" | "reported";
export type CommitResult = "committed" | "conflict" | "invalid";

export interface SessionKey {
  harness: Harness;
  sessionId: Identifier;
}

export interface StreamKey extends SessionKey {
  streamId: Identifier;
  installationId?: Identifier;
}

export interface Checkpoint {
  offset: Count;
  parserState: string;
}

export interface CheckpointSnapshot {
  version: Count;
  checkpoint: Checkpoint | null;
}

export interface Metadata {
  cwd?: string;
  branch?: string;
  repository?: string;
  parentSessionId?: Identifier;
}

export interface Message {
  id: Identifier;
  at: string;
  role: Role;
  text: string;
  sourceOrder?: SourceOrder;
  blockIndex?: Count;
  turnId?: Identifier;
  requestId?: Identifier;
  context?: Metadata;
}

export interface BranchObservation {
  at?: string;
  sourceOrder: SourceOrder;
}

export interface TokenCounts {
  inputTokens: Count;
  outputTokens: Count;
  cacheReadTokens?: Count;
  cacheWriteTokens?: Count;
  reasoningTokens?: Count;
}

export type UsageKind = "call" | "interval";

export interface Usage extends TokenCounts {
  id: Identifier;
  revision: Revision;
  at: string;
  model?: string;
  kind?: UsageKind;
  turnId?: Identifier;
  requestId?: Identifier;
}

export interface UsageWindow {
  historyId: Identifier;
  start: TokenCounts;
  end: TokenCounts;
  parts: Usage[];
}

export interface UsageAnchor {
  usageId: Identifier;
  historyId: Identifier;
  after?: TokenCounts;
}

export interface Batch {
  source: StreamKey;
  expectedVersion: Count;
  expectedOffset: Count;
  checkpoint: Checkpoint;
  metadata?: Metadata;
  branchObservation?: BranchObservation;
  messages: Message[];
  usage: Usage[];
  usageAnchors?: UsageAnchor[];
  usageWindows?: UsageWindow[];
  upgradeFromParserState?: string;
  hasGap?: boolean;
}

export interface SessionView {
  key: SessionKey;
  metadata: Metadata;
  messages: Message[];
  usage: Usage[];
  coverage: Coverage;
  observedTotalTokens: Count | null;
}

export interface CollectorStorage {
  readCheckpoint(source: StreamKey): Promise<CheckpointSnapshot>;
  commit(batch: Batch): Promise<CommitResult>;
  readSession(key: SessionKey): Promise<SessionView | null>;
}
