import { isAbsolute, relative, sep } from "node:path";
import type { harnesses } from "@tracerelic/shared";

export type Harness = (typeof harnesses)[number];
export type Identifier = string;
export type Count = number;
export type Revision = Count;
export type SourceOrder = Count;
export type PrefixDigest = string;
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

export interface SourceLocation {
  root: string;
  path: string;
  cwd?: string;
  projectDir?: string;
  currentFileCwd?: string;
}

export interface SourceObservation {
  location: SourceLocation;
  observedEnd: Count;
}

export interface SourceScope {
  harness: Harness;
  root: string;
  installationId?: string;
  sessionIds?: readonly string[];
  projectPaths?: readonly string[];
}

export type SourcePresence = "present" | "missing";

export interface AcknowledgedSource extends SourceObservation {
  source: StreamKey;
  acceptedOffset: Count;
  version: Count;
  presence: SourcePresence;
}

export interface PresenceWrite extends SourceObservation {
  source: StreamKey;
  expectedOffset: Count;
  expectedVersion: Count;
  presence: SourcePresence;
}

export interface MissingSource {
  status: "missing";
  source: StreamKey;
  acceptedOffset: Count;
  observedEnd: Count;
}

/** Use the source's own discovery fields to match a session or project selection. */
export function matchesSourceScope(scope: SourceScope, source: StreamKey, location: SourceLocation): boolean {
  if (source.harness !== scope.harness || source.installationId !== scope.installationId || location.root !== scope.root) return false;
  const { sessionIds = [], projectPaths = [] } = scope;
  if ((!sessionIds.length && !projectPaths.length) || sessionIds.includes(source.sessionId)) return true;
  return projectPaths.some(root => {
    if (!root) return false;
    if (location.projectDir && relative(root, location.projectDir) === "") return true;
    return [location.cwd, location.currentFileCwd].some(cwd => {
      if (!cwd) return false;
      const path = relative(root, cwd);
      return !isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep);
    });
  });
}

export interface VerifiedPrefix {
  offset: Count;
  prefixDigest: PrefixDigest;
}

export interface Checkpoint {
  offset: Count;
  parserState: string;
  prefixDigest?: PrefixDigest;
  replayThrough?: VerifiedPrefix;
  codexFork?: CodexForkCheckpoint;
  claudeCallOrigins?: true;
}

export interface ForkPosition {
  offset: Count;
  lineNumber: Count;
}

export interface CodexForkCheckpoint {
  parentSessionId: Identifier;
  inheritedThrough?: ForkPosition & { prefixDigest?: PrefixDigest };
  baseline?: TokenCounts;
  firstUncertain?: ForkPosition;
}

export interface CodexCallClaim {
  providerId: PrefixDigest;
  usageId: Identifier;
  ownerSessionId: Identifier;
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
export type UsageStatus = "provisional" | "final";

export interface CacheWriteDurations {
  cacheWrite5mTokens?: Count;
  cacheWrite1hTokens?: Count;
}

export interface ClaudeUsageReport extends TokenCounts, CacheWriteDurations {
  at: string;
  status: UsageStatus;
  messageId?: Identifier;
  requestId?: Identifier;
  turnId?: Identifier;
  model?: string;
  iterationId?: Identifier;
  origin?: ClaudeCallOrigin;
}

export interface ClaudeCallOrigin {
  kind: "own" | "copy" | "subagent";
  transcriptUuid?: Identifier;
  parentSessionId?: Identifier;
  parentMessageUuid?: Identifier;
  sourceOrder: SourceOrder;
  byteRange: ByteRange;
}

export interface ByteRange {
  startOffset: Count;
  endOffset: Count;
}

export type UsageDiagnosticCode = "invalid-claude-usage" | "unidentified-claude-call"
  | "unsupported-claude-cache-breakdown" | "unsupported-claude-iteration" | "ambiguous-transcript-replay"
  | "malformed-transcript-line" | "unsupported-codex-usage" | "codex-counter-reset" | "unresolved-codex-fork"
  | "unresolved-claude-fork";

export interface UsageDiagnostic {
  code: UsageDiagnosticCode;
  sourceOrder: SourceOrder;
  byteRange?: ByteRange;
}

export interface SourceUsageDiagnostic extends UsageDiagnostic {
  streamId: Identifier;
  installationId?: Identifier;
}

export interface Usage extends TokenCounts, CacheWriteDurations {
  id: Identifier;
  revision: Revision;
  at: string;
  model?: string;
  kind?: UsageKind;
  status?: UsageStatus;
  messageId?: Identifier;
  iterationId?: Identifier;
  turnId?: Identifier;
  requestId?: Identifier;
}

export interface UsageWindow {
  historyId: Identifier;
  start: TokenCounts;
  end: TokenCounts;
  boundaryObservations?: { start: string; end: string };
  parts: Usage[];
}

export interface UsageAnchor {
  usageId: Identifier;
  historyId: Identifier;
  after?: TokenCounts;
}

export interface Batch {
  source: StreamKey;
  sourceObservation?: SourceObservation;
  expectedVersion: Count;
  expectedOffset: Count;
  checkpoint: Checkpoint;
  metadata?: Metadata;
  branchObservation?: BranchObservation;
  messages: Message[];
  usage: Usage[];
  codexCallClaims?: CodexCallClaim[];
  reconcileCodexForkFrom?: Checkpoint;
  backfillClaudeOriginsFrom?: Checkpoint;
  claudeUsageReports?: ClaudeUsageReport[];
  usageDiagnostics?: UsageDiagnostic[];
  usageAnchors?: UsageAnchor[];
  usageWindows?: UsageWindow[];
  upgradeFromParserState?: string;
  resetFrom?: Checkpoint;
  hasGap?: boolean;
}

export interface SessionView {
  key: SessionKey;
  metadata: Metadata;
  messages: Message[];
  usage: Usage[];
  usageDiagnostics?: SourceUsageDiagnostic[];
  missingSources?: MissingSource[];
  coverage: Coverage;
  observedTotalTokens: Count | null;
}

export interface CollectorStorage {
  listSources(scope: SourceScope): Promise<AcknowledgedSource[]>;
  recordPresence(update: PresenceWrite): Promise<CommitResult>;
  readCheckpoint(source: StreamKey): Promise<CheckpointSnapshot>;
  commit(batch: Batch): Promise<CommitResult>;
  readSession(key: SessionKey): Promise<SessionView | null>;
}

const transportFailures = new Set([
  "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);

/** A storage request failed in transport. The destination may have accepted a write. */
export class StorageUnavailableError extends Error {
  static is(error: unknown): boolean {
    const visited = new Set<Error>();
    while (error instanceof Error && !visited.has(error)) {
      if (error instanceof StorageUnavailableError) return true;
      if (error instanceof DOMException && error.name === "TimeoutError") return true;
      if ("code" in error && typeof error.code === "string" && transportFailures.has(error.code)) return true;
      visited.add(error);
      error = error.cause;
    }
    return false;
  }
}

/** Storage asked the scanner to delay its next operation. */
export class StorageBackoffError extends StorageUnavailableError {
  readonly retryAfterMs: number;

  constructor(retryAfterMs = 1000) {
    super("Collector storage requested a delayed retry");
    this.retryAfterMs = Number.isFinite(retryAfterMs) ? Math.max(1000, Math.ceil(retryAfterMs)) : 1000;
  }
}

/** A scan can resume after the caller supplies a valid credential. */
export class StorageAuthenticationError extends Error {
  constructor() {
    super("The collector API rejected the credential. Check TRACERELIC_COLLECTOR_TOKEN.");
  }
}
