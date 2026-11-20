import { isDeepStrictEqual } from "node:util";
import { isRecordedTimestamp, recordedInstant } from "../recorded-timestamp.ts";
import type {
  AcknowledgedSource, Batch, BranchObservation, Checkpoint, CheckpointSnapshot, CollectorStorage, CommitResult, Coverage,
  Message, Metadata, MissingSource, PresenceWrite, SessionKey, SessionView, SourceScope, StreamKey, Usage, UsageAnchor,
} from "./collector-storage.ts";
import { checkpointFailure } from "./checkpoint-validation.ts";
import { ClaudeCallOwners } from "./claude-call-owners.ts";
import { ClaudeUsageLedger } from "./claude-usage-ledger.ts";
import { CodexCallOwners } from "./codex-call-owners.ts";
import { StoredSource } from "./source-inventory.ts";
import { SourceUsageDiagnostics } from "./source-usage-diagnostics.ts";
import { definedFields, isCount, isIdentifier, isNativeCodexCall, isRecord, isTokenCounts, isUsage, mergeCodexCall } from "./usage-validation.ts";
import { UsageWindows } from "./usage-windows.ts";

function encodeSessionKey(key: SessionKey): string {
  return JSON.stringify([key.harness, key.sessionId]);
}

function encodeStreamKey(source: StreamKey): string {
  const parts = [source.harness, source.sessionId, source.streamId];
  if (source.installationId !== undefined) parts.push(source.installationId);
  return JSON.stringify(parts);
}

function hasValidPosition(write: Pick<Batch, "source" | "expectedVersion" | "expectedOffset">): boolean {
  const source = write?.source;
  return isRecord(source) && (source.harness === "codex" || source.harness === "claude")
    && isIdentifier(source.sessionId) && isIdentifier(source.streamId)
    && (source.installationId === undefined || isIdentifier(source.installationId))
    && isCount(write.expectedVersion) && isCount(write.expectedOffset);
}

function isRecordNumber(value: number): boolean {
  return isCount(value) && value > 0;
}

function hasValidMetadata(fields: Metadata | undefined): boolean {
  if (fields === undefined) return true;
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return false;
  return [fields.cwd, fields.branch, fields.repository].every(value => value === undefined || typeof value === "string")
    && (fields.parentSessionId === undefined || isIdentifier(fields.parentSessionId));
}

function hasValidMessage(message: Message): boolean {
  return isRecord(message) && isIdentifier(message.id) && isRecordedTimestamp(message.at)
    && (message.role === "user" || message.role === "assistant")
    && typeof message.text === "string"
    && (message.sourceOrder === undefined || isRecordNumber(message.sourceOrder))
    && (message.blockIndex === undefined || isCount(message.blockIndex))
    && (message.turnId === undefined || isIdentifier(message.turnId))
    && (message.requestId === undefined || isIdentifier(message.requestId))
    && hasValidMetadata(message.context);
}

interface StoredMessage {
  streamId: string;
  value: Message;
}

function conflictingFields<T extends object>(known: T, incoming: T): boolean {
  for (const key in incoming) {
    if (known[key] !== undefined && incoming[key] !== undefined && known[key] !== incoming[key]) return true;
  }
  return false;
}

function replayMessage(known: StoredMessage, incoming: Message, streamId: string): StoredMessage | null {
  const { sourceOrder, blockIndex, context, ...fields } = incoming;
  const previous = known.value;
  if (conflictingFields(previous, fields) || conflictingFields(previous.context ?? {}, context ?? {})) return null;
  const value = { ...fields, ...previous };
  if (context) value.context = { ...context, ...previous.context };
  const positioned = previous.sourceOrder !== undefined || previous.blockIndex !== undefined;
  const sameRecord = sourceOrder === undefined || previous.sourceOrder === undefined || sourceOrder === previous.sourceOrder;
  if (!positioned || (streamId === known.streamId && sameRecord)) {
    if (sourceOrder !== undefined) value.sourceOrder ??= sourceOrder;
    if (blockIndex !== undefined) value.blockIndex ??= blockIndex;
  }
  return { streamId: positioned ? known.streamId : streamId, value };
}

function mergeMessages(
  previous: Map<string, StoredMessage> | undefined, incoming: Message[], streamId: string,
): Map<string, StoredMessage> | null {
  const messages = new Map(previous);
  for (const entry of incoming) {
    if (!hasValidMessage(entry)) return null;
    const value = definedFields(entry);
    if (value.context) value.context = definedFields(value.context);
    const existing = messages.get(value.id);
    const next = existing ? replayMessage(existing, value, streamId) : { streamId, value };
    if (!next) return null;
    messages.set(value.id, next);
  }
  return messages;
}

function orderedMessages(records: Map<string, StoredMessage>): Message[] {
  const messages: Message[] = [];
  const positions = new Map<string, number[]>();
  for (const { streamId, value } of records.values()) {
    if (value.sourceOrder !== undefined) {
      const slots = positions.get(streamId) ?? [];
      slots.push(messages.length);
      positions.set(streamId, slots);
    }
    messages.push(value);
  }
  // Order only the slots whose records share a source. Leave unrelated and unpositioned messages in place.
  for (const slots of positions.values()) {
    const ordered = slots.map(slot => messages[slot]).sort((left, right) =>
      (left.sourceOrder ?? 0) - (right.sourceOrder ?? 0) || (left.blockIndex ?? 0) - (right.blockIndex ?? 0));
    slots.forEach((slot, index) => { messages[slot] = ordered[index]; });
  }
  return messages;
}

function mergeUsage(previous: readonly Usage[], incoming: readonly Usage[], codexCalls: ReadonlySet<string> | undefined): Usage[] | null {
  const records = new Map(previous.map((usage) => [usage.id, usage]));
  for (const entry of incoming) {
    if (!isUsage(entry)) return null;
    const usage = definedFields(entry);
    const existing = records.get(usage.id);
    if (existing?.revision === usage.revision && !isDeepStrictEqual(existing, usage)) {
      const merged = codexCalls?.has(usage.id) && mergeCodexCall(existing, usage);
      if (!merged) return null;
      records.set(usage.id, merged);
    } else if (!existing || usage.revision > existing.revision) records.set(usage.id, usage);
  }
  return [...records.values()];
}

interface StoredAnchor {
  source: StreamKey;
  generation: number;
  anchor: UsageAnchor;
}

type UsageInput = Pick<Batch, "source" | "usage" | "usageAnchors" | "usageWindows">;

/** Keep just the measurement inputs needed to remove one stream's mistaken fork attribution. */
interface CodexUsageWrite {
  previous?: CodexUsageWrite;
  input: UsageInput;
  stream: string;
  generation: number;
}

function rememberUsage(previous: CodexUsageWrite | undefined, batch: UsageInput, stream: string, generation: number) {
  const { source, usage, usageWindows, usageAnchors } = batch;
  if (source.harness !== "codex" || (!usage.length && !usageWindows?.length && !usageAnchors?.length)) return previous;
  return { previous, input: { source, usage, usageWindows, usageAnchors }, stream, generation };
}

function mergeAnchors(previous: Map<string, StoredAnchor[]> | undefined, batch: UsageInput, stream: string, generation: number) {
  const anchors = new Map(previous);
  if (!batch.usageAnchors?.length) return anchors;
  const calls = new Set(batch.usage.filter(record => record?.kind === "call").map(record => record.id));
  for (const anchor of batch.usageAnchors) {
    if (!isRecord(anchor) || !isIdentifier(anchor.usageId) || !calls.has(anchor.usageId) || !isIdentifier(anchor.historyId)
      || (anchor.after !== undefined && !isTokenCounts(anchor.after))) return null;
    const known = anchors.get(anchor.usageId) ?? [];
    if (known.some(entry => entry.generation === generation && encodeStreamKey(entry.source) === stream
      && isDeepStrictEqual(entry.anchor, anchor))) continue;
    anchors.set(anchor.usageId, [...known, { source: batch.source, generation, anchor }]);
  }
  return anchors;
}

interface StoredUsage {
  standalone: Usage[];
  anchors: Map<string, StoredAnchor[]>;
  windows: UsageWindows;
  claude?: ClaudeUsageLedger;
  order?: ReadonlySet<string>;
}

interface MeasurementState {
  measurements: StoredUsage;
  view: { usage: Usage[] };
}

function previousNativeAnchors(previous: MeasurementState | undefined, anchors: Map<string, StoredAnchor[]>,
  stream: string, generation: number): StoredAnchor[] {
  if (!previous || !anchors.size) return [];
  const accepted = new Set(previous.measurements.windows.pendingNativeIds);
  if (generation) {
    for (const call of previous.view.usage) {
      if (!isNativeCodexCall(call)) continue;
      const placements = anchors.get(call.id) ?? [];
      if (placements.some(entry => entry.generation < generation && encodeStreamKey(entry.source) === stream)) accepted.add(call.id);
    }
  }
  return [...accepted].flatMap(id => anchors.get(id) ?? []);
}

function mergeRecordedUsage(previous: MeasurementState | undefined, batch: UsageInput, stream: string, generation: number) {
  if (!Array.isArray(batch.usage) || (batch.usageWindows !== undefined && !Array.isArray(batch.usageWindows))
    || (batch.usageAnchors !== undefined && !Array.isArray(batch.usageAnchors))) return null;
  const anchors = mergeAnchors(previous?.measurements.anchors, batch, stream, generation);
  if (!anchors) return null;
  const retained = batch.usageWindows?.length || batch.usageAnchors?.length ? previousNativeAnchors(previous, anchors, stream, generation) : [];
  const windows = UsageWindows.merge(previous?.measurements.windows, batch.usageWindows ?? [], batch.source, generation, retained);
  if (!windows) return null;
  const parts = windows.measurements;
  const activeIds = new Set(parts.map(part => part.id));
  const codexCalls = batch.source.harness === "codex" ? new Set([...anchors.keys(), ...activeIds]) : undefined;
  const standalone = mergeUsage(previous?.measurements.standalone ?? [], batch.usage, codexCalls);
  if (!standalone) return null;
  const visible = standalone.filter(call => activeIds.has(call.id) || !windows.mayCoverCall(anchors.get(call.id) ?? []));
  // Carry forward the first time and position only for IDs that survived this transaction.
  const incoming = [...visible, ...parts];
  const ids = new Set(incoming.map(record => record.id));
  const surviving = previous?.view.usage.filter(record => ids.has(record.id)) ?? [];
  const usage = mergeUsage(surviving, incoming, codexCalls);
  if (!usage) return null;
  const hasGap = windows.hasGap || activeIds.size !== parts.length;
  return { stored: { standalone, anchors, windows }, usage, hasGap };
}

function combineClaudeUsage(previous: StoredSession | undefined, ordinary: Usage[], claude: ClaudeUsageLedger) {
  // Only native evidence can resolve a previously withdrawn Claude measurement.
  if (ordinary.some(record => claude.measurementIds.has(record.id))) return null;
  const order = new Set(previous?.measurements.order ?? previous?.view.usage.map(record => record.id));
  for (const record of ordinary) order.add(record.id);
  // A call can be observed and withdrawn within a single transaction. Keep its first position.
  for (const id of claude.measurementIds) order.add(id);
  if (!ordinary.length) return { order, usage: [...claude.measurements] };
  const active = new Map(ordinary.map(record => [record.id, record]));
  for (const record of claude.measurements) active.set(record.id, record);
  const usage: Usage[] = [];
  for (const id of order) {
    const record = active.get(id);
    if (record) usage.push(record);
  }
  return { order, usage };
}

function retainOtherUsage(writes: CodexUsageWrite | undefined, stream: string, generation: number) {
  const retained: CodexUsageWrite[] = [];
  for (let write = writes; write; write = write.previous) {
    if (write.stream !== stream || write.generation !== generation) retained.push(write);
  }
  let state: MeasurementState | undefined;
  let history: CodexUsageWrite | undefined;
  for (const write of retained.reverse()) {
    const recorded = mergeRecordedUsage(state, write.input, write.stream, write.generation);
    if (!recorded) return null;
    state = { measurements: recorded.stored, view: { usage: recorded.usage } };
    history = { ...write, previous: history };
  }
  return { state, history };
}

function mergeMeasurements(previous: StoredSession | undefined, batch: Batch, stream: string, generation: number) {
  const reports = batch.claudeUsageReports;
  if (reports !== undefined && !Array.isArray(reports)) return null;
  let state: MeasurementState | undefined = previous;
  let history = previous?.codexUsageWrites;
  if (batch.reconcileCodexForkFrom) {
    const retained = retainOtherUsage(history, stream, generation);
    if (!retained) return null;
    ({ state, history } = retained);
  }
  const recorded = mergeRecordedUsage(state, batch, stream, generation);
  if (!recorded) return null;
  history = rememberUsage(history, batch, stream, generation);
  const stored: StoredUsage = recorded.stored;
  let usage = recorded.usage;
  let claude = previous?.measurements.claude;
  if (reports?.length) {
    if (batch.source.harness !== "claude" || (batch.checkpoint.claudeCallOrigins && reports.some(report => !report?.origin))) return null;
    const next = ClaudeUsageLedger.merge(claude, reports, batch.source.sessionId);
    if (!next) return null;
    claude = next;
  }
  if (claude) {
    const combined = combineClaudeUsage(previous, usage, claude);
    if (!combined) return null;
    usage = combined.usage;
    stored.order = combined.order;
    stored.claude = claude;
  }
  return { stored, usage, history, hasGap: recorded.hasGap };
}

interface RecordedBranch {
  streamId: string;
  name: string;
  sourceOrder: number;
  instant?: { second: number; fraction: string };
}

interface BranchHistory {
  byStream: Map<string, RecordedBranch>;
  latest: RecordedBranch;
}

function recordedBranch(streamId: string, name: string, observation: BranchObservation): RecordedBranch | null {
  const { at, sourceOrder } = observation;
  if (!isRecordNumber(sourceOrder)) return null;
  const branch = { streamId, name, sourceOrder };
  if (at === undefined) return branch;
  const instant = recordedInstant(at);
  return instant ? { ...branch, instant } : null;
}

function mergeBranches(
  previous: BranchHistory | undefined, batch: Batch, streamId: string,
): BranchHistory | null | undefined {
  const observation = batch.branchObservation;
  if (observation === undefined) return previous;
  if (!observation || !batch.metadata?.branch) return null;
  const candidate = recordedBranch(streamId, batch.metadata.branch, observation);
  if (!candidate) return null;
  const known = previous?.byStream.get(streamId);
  if (known && known.sourceOrder >= candidate.sourceOrder) return previous;
  const byStream = new Map(previous?.byStream);
  byStream.set(streamId, candidate);
  let latest = previous && previous.latest.streamId !== streamId ? previous.latest : candidate;
  for (const branch of byStream.values()) {
    const time = branch.instant;
    const current = latest.instant;
    if (!time || !current) continue;
    if (time.second > current.second || (time.second === current.second && time.fraction > current.fraction)) {
      latest = branch;
    }
  }
  return { byStream, latest };
}

interface StoredSession {
  version: number;
  checkpoints: Map<string, StoredSource>;
  view: Pick<SessionView, "key" | "metadata" | "usage" | "usageDiagnostics">;
  messages: Map<string, StoredMessage>;
  measurements: StoredUsage;
  codexUsageWrites?: CodexUsageWrite;
  branches?: BranchHistory;
  hasGap: boolean;
}

function coverage(records: number, hasGap: boolean): Coverage {
  if (records === 0) return "unknown";
  return hasGap ? "partial" : "reported";
}

function totalTokens(usage: readonly Usage[]): number {
  return usage.reduce((sum, record) => sum + record.inputTokens + record.outputTokens, 0);
}

function mergeSessionRecords(
  previous: StoredSession | undefined, batch: Batch, stream: string, generation: number,
): Omit<StoredSession, "version" | "checkpoints"> | null {
  if (!hasValidMetadata(batch.metadata) || !Array.isArray(batch.messages)) return null;
  const messages = mergeMessages(previous?.messages, batch.messages, stream);
  const measurements = mergeMeasurements(previous, batch, stream, generation);
  // Physical line numbers establish branch order only within one version of a transcript.
  const branches = mergeBranches(previous?.branches, batch, JSON.stringify([stream, generation]));
  const diagnostics = SourceUsageDiagnostics.merge(previous?.view.usageDiagnostics, batch);
  if (!messages || !measurements || branches === null || !diagnostics) return null;
  const { usage, stored } = measurements;
  const hasGap = previous?.hasGap === true || batch.hasGap === true || measurements.hasGap || diagnostics.hasGap;
  const metadata = { ...previous?.view.metadata, ...definedFields(batch.metadata ?? {}) };
  if (branches) metadata.branch = branches.latest.name;
  const view = {
    key: { harness: batch.source.harness, sessionId: batch.source.sessionId }, metadata, usage,
    ...(diagnostics.values && { usageDiagnostics: diagnostics.values }),
  };
  return { view, messages, measurements: stored, branches, hasGap, codexUsageWrites: measurements.history };
}

export class InMemoryCollectorStorage implements CollectorStorage {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly codexOwners = new CodexCallOwners();
  private claudeOwners = new ClaudeCallOwners();

  async listSources(scope: SourceScope): Promise<AcknowledgedSource[]> {
    const selected: AcknowledgedSource[] = [];
    for (const session of this.sessions.values()) {
      if (session.view.key.harness !== scope.harness) continue;
      for (const stream of session.checkpoints.values()) {
        const source = stream.selected(scope, session.version);
        if (source) selected.push(source);
      }
    }
    return structuredClone(selected);
  }

  async recordPresence(update: PresenceWrite): Promise<CommitResult> {
    if (!hasValidPosition(update)) return "invalid";
    const key = encodeSessionKey(update.source);
    const stream = encodeStreamKey(update.source);
    const session = this.sessions.get(key);
    const current = session?.checkpoints.get(stream);
    if (!current || !session) return "invalid";
    if (session.version !== update.expectedVersion || current.checkpoint.offset !== update.expectedOffset) return "conflict";
    const next = current.record(update);
    if (!next) return "invalid";
    if (next === current) return "committed";
    const version = session.version + 1;
    if (!isCount(version)) return "invalid";
    const checkpoints = new Map(session.checkpoints).set(stream, next);
    this.sessions.set(key, { ...session, version, checkpoints });
    return "committed";
  }

  async readCheckpoint(source: StreamKey): Promise<CheckpointSnapshot> {
    const session = this.sessions.get(encodeSessionKey(source));
    const checkpoint = session?.checkpoints.get(encodeStreamKey(source))?.checkpoint ?? null;
    return { version: session?.version ?? 0, checkpoint: structuredClone(checkpoint) };
  }

  async readSession(key: SessionKey): Promise<SessionView | null> {
    const stored = this.sessions.get(encodeSessionKey(key));
    if (!stored) return null;
    const { usage, diagnostics, hasGap } = key.harness === "claude" ? this.claudeOwners.view(key.sessionId, stored.view.usage, stored.measurements.order)
      : { usage: this.codexOwners.visible(key.sessionId, stored.view.usage), diagnostics: [], hasGap: false };
    let partial = stored.hasGap || hasGap === true || diagnostics.length > 0;
    const missingSources: MissingSource[] = [];
    for (const source of stored.checkpoints.values()) {
      partial ||= source.hasGap;
      const missing = source.missing();
      if (missing) missingSources.push(missing);
    }
    return structuredClone({ ...stored.view, usage, messages: orderedMessages(stored.messages),
      coverage: coverage(usage.length, partial), observedTotalTokens: usage.length ? totalTokens(usage) : null,
      ...(diagnostics.length && { usageDiagnostics: [...stored.view.usageDiagnostics ?? [], ...diagnostics] }),
      ...(missingSources.length && { missingSources }),
    });
  }

  private verifiedParent(sessionId: string, incoming: StoredSession): string | undefined {
    const session = incoming.view.key.sessionId === sessionId ? incoming : this.sessions.get(encodeSessionKey({ harness: "codex", sessionId }));
    let parent: string | undefined;
    for (const { checkpoint } of session?.checkpoints.values() ?? []) {
      const fork = checkpoint.codexFork;
      if (!fork?.inheritedThrough) continue;
      if (parent !== undefined && parent !== fork.parentSessionId) return;
      parent = fork.parentSessionId;
    }
    return parent;
  }

  /** Validate every changed peer before publishing any part of the transfer. */
  private advancePeers(source: SessionKey, transfers: ReadonlySet<string>, validUsage?: (peer: StoredSession) => boolean): boolean {
    const peers = new Map<string, StoredSession>();
    for (const id of transfers) {
      if (id === source.sessionId) continue;
      const key = encodeSessionKey({ harness: source.harness, sessionId: id });
      const stored = this.sessions.get(key);
      if (!stored) continue;
      if (!isCount(stored.version + 1) || (validUsage && !validUsage(stored))) return false;
      peers.set(key, { ...stored, version: stored.version + 1 });
    }
    for (const [key, updated] of peers) this.sessions.set(key, updated);
    return true;
  }

  private publishOwnership(batch: Batch, next: StoredSession, current: Checkpoint | undefined): boolean {
    if (batch.source.harness === "claude") {
      if (batch.codexCallClaims !== undefined) return false;
      const staged = this.claudeOwners.prepare(batch, next.measurements.claude?.measurements ?? [], next.view.metadata.parentSessionId);
      if (!staged) return false;
      const validUsage = (session: StoredSession) => {
        const projected = staged.owners.view(session.view.key.sessionId, session.view.usage, session.measurements.order);
        return !projected.conflictingUsageId && isCount(totalTokens(projected.usage));
      };
      if (!validUsage(next) || !this.advancePeers(batch.source, staged.changedSessions, validUsage)) return false;
      this.claudeOwners = staged.owners;
      return true;
    }
    if (!isCount(totalTokens(next.view.usage))) return false;
    const newProof = batch.checkpoint.codexFork?.inheritedThrough !== undefined &&
      !isDeepStrictEqual(batch.checkpoint.codexFork, current?.codexFork);
    const ownership = this.codexOwners.prepare(batch, next.view.usage, id => this.verifiedParent(id, next), newProof);
    if (ownership === null) return false;
    if (!ownership) return true;
    if (!this.advancePeers(batch.source, ownership.transfers)) return false;
    this.codexOwners.publish(ownership);
    return true;
  }

  async commit(batch: Batch): Promise<CommitResult> {
    if (!hasValidPosition(batch)) return "invalid";
    const { source, expectedVersion, expectedOffset } = batch;
    const session = encodeSessionKey(source);
    const stream = encodeStreamKey(source);
    // Compare both values and publish the complete session in one synchronous turn.
    const previous = this.sessions.get(session);
    const currentVersion = previous?.version ?? 0;
    const current = previous?.checkpoints.get(stream);
    if (expectedVersion !== currentVersion || expectedOffset !== (current?.checkpoint.offset ?? 0)) return "conflict";
    const version = currentVersion + 1;
    if (!isCount(version)) return "invalid";
    const failure = checkpointFailure(batch, current?.checkpoint);
    if (failure) return failure;
    const incoming = structuredClone(batch);
    // A rewritten file can describe the same counters through a different set of reports.
    const generation = incoming.resetFrom ? version : current?.generation ?? 0;
    const accepted = StoredSource.accept(current, incoming, generation);
    if (!accepted) return "invalid";
    const records = mergeSessionRecords(previous, incoming, stream, generation);
    if (!records) return "invalid";
    const checkpoints = new Map(previous?.checkpoints);
    checkpoints.set(stream, accepted);
    const next = { version, checkpoints, ...records };
    if (!this.publishOwnership(incoming, next, current?.checkpoint)) return "invalid";
    this.sessions.set(session, next);
    return "committed";
  }
}
