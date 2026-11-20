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
}

export interface Checkpoint {
  offset: Count;
  parserState: string;
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

export interface Usage {
  id: Identifier;
  revision: Revision;
  at: string;
  model?: string;
  inputTokens: Count;
  outputTokens: Count;
  cacheReadTokens?: Count;
  cacheWriteTokens?: Count;
  reasoningTokens?: Count;
}

export interface Batch {
  source: StreamKey;
  expectedOffset: Count;
  checkpoint: Checkpoint;
  metadata?: Metadata;
  branchObservation?: BranchObservation;
  messages: Message[];
  usage: Usage[];
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
  readCheckpoint(source: StreamKey): Promise<Checkpoint | null>;
  commit(batch: Batch): Promise<CommitResult>;
  readSession(key: SessionKey): Promise<SessionView | null>;
}
