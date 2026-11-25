import { matchesRecordedPath, recordedPathDialect, type harnesses } from "@tracerelic/shared";

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

/** The text keys of a session and of a stream. */
export class StreamKeys {
  /** One session of one harness. */
  static session(key: SessionKey): string {
    return JSON.stringify([key.harness, key.sessionId]);
  }

  /** One stream as storage keys it. An absent installation ID has no place in this key. */
  static stream(source: StreamKey): string {
    const parts = [source.harness, source.sessionId, source.streamId];
    if (source.installationId !== undefined) parts.push(source.installationId);
    return JSON.stringify(parts);
  }

  /** One source as the scanner names it. An absent installation ID keeps its place, as null.
   * For such a source this text is different from the text of `stream`. */
  static sourceId(source: StreamKey): string {
    return JSON.stringify([source.harness, source.sessionId, source.streamId, source.installationId]);
  }
}

/** The tests on values of the contract that the parsers and the storage both make. */
export class ContractValues {
  /** True for the text of a SHA-256 digest: 64 hexadecimal digits in lower case. */
  static isDigest(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  }

  /** True for the ID of a native Codex call: `call:native:` and a digest. */
  static isNativeCallId(value: unknown): value is string {
    return typeof value === "string" && /^call:native:[0-9a-f]{64}$/.test(value);
  }
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
  observedPrefixDigest?: PrefixDigest;
  checkedPrefix?: VerifiedPrefix;
}

export interface ObservedExtent {
  offset: Count;
  prefixDigest?: PrefixDigest;
}

export interface SourceScope {
  harness: Harness;
  root: string;
  installationId?: string;
  sessionIds?: readonly string[];
  projectPaths?: readonly string[];
}

export type SourcePresence = "present" | "missing";
export type CodexIdentityStatus = "unverified" | "messages-repaired" | "repaired";
export type CodexIdentityProof = { status: "unverified" } | {
  status: "verified";
  peerSessionId: string;
  peerStreamId: string;
  expectedPeerVersion: Count;
  headerEnd: Count;
  accepted: VerifiedPrefix;
  peer: VerifiedPrefix;
};

export interface AcknowledgedSource extends SourceObservation {
  source: StreamKey;
  acceptedOffset: Count;
  version: Count;
  presence: SourcePresence;
  generation?: Count;
  unrecovered?: ObservedExtent;
  codexIdentityStatus?: CodexIdentityStatus;
}

export interface PresenceWrite extends SourceObservation {
  source: StreamKey;
  expectedOffset: Count;
  expectedVersion: Count;
  presence: SourcePresence;
  codexIdentity?: CodexIdentityProof;
}

export interface MissingSource {
  status: "missing";
  source: StreamKey;
  acceptedOffset: Count;
  observedEnd: Count;
}

/** A source of the original scanner: its stream ID, its location and the last line of its checkpoint. */
export class LegacyScannerSource {
  /** The original scanner embedded its root in the stream ID when installationId was omitted. */
  static location(harness: Harness, streamId: string): SourceLocation | undefined {
    if (harness === "codex") {
      try {
        const pair: unknown = JSON.parse(streamId);
        if (!Array.isArray(pair) || pair.length !== 2) return;
        const [root, path] = pair;
        const dialect = recordedPathDialect(root);
        if (typeof root === "string" && dialect && typeof path === "string" && path === dialect.basename(path) && /^rollout-.*\.jsonl$/.test(path) && !path.includes("\0")) return { root, path };
      } catch { /* Other adapters can use opaque stream IDs. */ }
      return;
    }
    const dialect = recordedPathDialect(streamId);
    if (!dialect || !/\.jsonl(?:\.superseded-\d.*)?$/.test(streamId)) return;
    const { basename, dirname, relative } = dialect;
    const directory = dirname(streamId);
    const candidates = [directory];
    if (basename(directory) === "subagents" && basename(streamId).startsWith("agent-")) candidates.push(dirname(dirname(directory)));
    const projects = candidates.filter(path => basename(dirname(path)) === "projects");
    if (projects.length !== 1) return;
    const [projectDir] = projects;
    const root = dirname(dirname(projectDir));
    return { root, path: relative(root, streamId), projectDir };
  }

  /** A scanner's original stream ID encodes the same root and path as its observation. */
  static stream(harness: Harness, { root, path }: SourceLocation): string | undefined {
    const dialect = recordedPathDialect(root);
    if (!dialect) return;
    const candidate = harness === "codex" ? JSON.stringify([root, path]) : dialect.join(root, path);
    const parsed = LegacyScannerSource.location(harness, candidate);
    if (parsed?.root === root && parsed.path === path) return candidate;
  }

  /** A legacy scanner checkpoint has either an empty state or a decoder with its last physical line. */
  private static position(checkpoint: Checkpoint): number | "empty" | undefined {
    if (!checkpoint.offset || checkpoint.evidenceVersion) return;
    let state: { version?: unknown; lineNumber?: unknown; decoder?: unknown } | null;
    try { state = JSON.parse(checkpoint.parserState || "{}"); } catch { return; }
    if (!state || typeof state !== "object" || Array.isArray(state)) return;
    if (!Object.keys(state).length) return "empty";
    if (typeof state.version !== "number" || !Number.isInteger(state.version) || state.version < 1 || state.version > 4
      || typeof state.lineNumber !== "number" || !Number.isSafeInteger(state.lineNumber) || state.lineNumber < 1 || state.lineNumber > checkpoint.offset
      || !state.decoder || typeof state.decoder !== "object" || Array.isArray(state.decoder)) return;
    return state.lineNumber;
  }

  static line(checkpoint: Checkpoint): number | undefined {
    const position = LegacyScannerSource.position(checkpoint);
    return typeof position === "number" ? position : undefined;
  }

  /** An empty state identifies no line. Its source can still establish that history needs checking. */
  static needsHistoryVerification(source: StreamKey, checkpoint: Checkpoint, location?: SourceLocation): boolean {
    const position = LegacyScannerSource.position(checkpoint);
    if (position !== "empty") return position !== undefined;
    const embedded = LegacyScannerSource.location(source.harness, source.streamId);
    if (embedded) return !location || (embedded.root === location.root && embedded.path === location.path);
    return !!location && source.streamId === location.path && LegacyScannerSource.stream(source.harness, location) !== undefined;
  }

  /** A missing generation has no reliable row-level range. Identify its source at the first line. */
  static historyDiagnostic({ streamId, installationId }: StreamKey): SourceUsageDiagnostic {
    return { code: "unverified-source-history", sourceOrder: 1, streamId, ...(installationId !== undefined && { installationId }) };
  }
}

/** The selection of sources by session and by project. */
export class SourceScopes {
  /** Use the source's own discovery fields to match a session or project selection. */
  static matches(scope: SourceScope, source: StreamKey, location: SourceLocation): boolean {
    if (source.harness !== scope.harness || source.installationId !== scope.installationId || location.root !== scope.root) return false;
    const { sessionIds = [], projectPaths = [] } = scope;
    if ((!sessionIds.length && !projectPaths.length) || sessionIds.includes(source.sessionId)) return true;
    return projectPaths.some(root => matchesRecordedPath(root, location.projectDir, true)
      || matchesRecordedPath(root, location.cwd) || matchesRecordedPath(root, location.currentFileCwd));
  }
}

export interface VerifiedPrefix {
  offset: Count;
  prefixDigest: PrefixDigest;
}

export interface Checkpoint {
  evidenceVersion?: 1;
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

/** A specific provider call and another ID observed on the same measurement. */
export interface CodexCallAlias {
  callUsageId: Identifier;
  aliasUsageId: Identifier;
  sourceOrder?: Count;
  byteRange?: ByteRange;
  closing?: Pick<Usage, "inputTokens" | "outputTokens" | "turnId" | "responseId">;
}

export interface CheckpointSnapshot {
  version: Count;
  checkpoint: Checkpoint | null;
  observedThrough?: ObservedExtent;
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
  iterationPosition?: Count;
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
  | "unresolved-claude-fork" | "ambiguous-codex-call" | "ambiguous-claude-iteration" | "unverified-source-history";

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
  responseId?: Identifier;
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
  messageOrigins?: { sourceOrder: SourceOrder; prefixDigest: PrefixDigest; refinesAccepted?: true }[];
  repairEvidenceFrom?: Checkpoint;
  usage: Usage[];
  codexCallClaims?: CodexCallClaim[];
  codexCallAliases?: CodexCallAlias[];
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
  canonicalSource?(source: StreamKey): Promise<string | undefined>;
  mergeSourceAlias?(source: StreamKey, target: string, version: number): Promise<boolean>;
  resolveSource?(source: StreamKey, location: SourceLocation, verify: (checkpoint: Checkpoint) => Promise<boolean>): Promise<StreamKey>;
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
