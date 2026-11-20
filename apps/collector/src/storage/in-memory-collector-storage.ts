import { isDeepStrictEqual } from "node:util";
import { isRecordedTimestamp } from "../recorded-timestamp.ts";
import type {
  Batch, BranchObservation, Checkpoint, CheckpointSnapshot, CollectorStorage, CommitResult, Coverage, Harness,
  Message, Metadata, SessionKey, SessionView, SourceUsageDiagnostic, StreamKey, Usage, UsageAnchor,
} from "./collector-storage.ts";
import { ClaudeUsageLedger } from "./claude-usage-ledger.ts";
import { isCount, isIdentifier, isRecord, isTokenCounts, isUsage, mergeCodexCall } from "./usage-validation.ts";
import { UsageWindows } from "./usage-windows.ts";

function encodeSessionKey(key: SessionKey): string {
  return JSON.stringify([key.harness, key.sessionId]);
}

function encodeStreamKey(source: StreamKey): string {
  const parts = [source.harness, source.sessionId, source.streamId];
  if (source.installationId !== undefined) parts.push(source.installationId);
  return JSON.stringify(parts);
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

function definedFields<T extends object>(fields: T): T {
  const copy = { ...fields };
  for (const key in copy) {
    if (copy[key] === undefined) delete copy[key];
  }
  return copy;
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
  anchor: UsageAnchor;
}

function mergeAnchors(previous: Map<string, StoredAnchor[]> | undefined, batch: Batch, stream: string) {
  const anchors = new Map(previous);
  if (!batch.usageAnchors?.length) return anchors;
  const calls = new Set(batch.usage.filter(record => record?.kind === "call").map(record => record.id));
  for (const anchor of batch.usageAnchors) {
    if (!isRecord(anchor) || !isIdentifier(anchor.usageId) || !calls.has(anchor.usageId) || !isIdentifier(anchor.historyId)
      || (anchor.after !== undefined && !isTokenCounts(anchor.after))) return null;
    const known = anchors.get(anchor.usageId) ?? [];
    if (known.some(entry => encodeStreamKey(entry.source) === stream && isDeepStrictEqual(entry.anchor, anchor))) continue;
    anchors.set(anchor.usageId, [...known, { source: batch.source, anchor }]);
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

function mergeRecordedUsage(previous: StoredSession | undefined, batch: Batch, stream: string) {
  if (!Array.isArray(batch.usage) || (batch.usageWindows !== undefined && !Array.isArray(batch.usageWindows))
    || (batch.usageAnchors !== undefined && !Array.isArray(batch.usageAnchors))) return null;
  const anchors = mergeAnchors(previous?.measurements.anchors, batch, stream);
  const windows = UsageWindows.merge(previous?.measurements.windows, batch.usageWindows ?? [], batch.source);
  if (!anchors || !windows) return null;
  const parts = windows.measurements;
  const activeIds = new Set(parts.map(part => part.id));
  const codexCalls = batch.source.harness === "codex" ? new Set([...anchors.keys(), ...activeIds]) : undefined;
  const standalone = mergeUsage(previous?.measurements.standalone ?? [], batch.usage, codexCalls);
  if (!standalone) return null;
  const visible = standalone.filter(call => activeIds.has(call.id)
    || !anchors.get(call.id)?.some(({ anchor, source }) => windows.mayCover(anchor, source)));
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

function mergeMeasurements(previous: StoredSession | undefined, batch: Batch, stream: string) {
  const reports = batch.claudeUsageReports;
  if (reports !== undefined && !Array.isArray(reports)) return null;
  const recorded = mergeRecordedUsage(previous, batch, stream);
  if (!recorded) return null;
  const stored: StoredUsage = recorded.stored;
  let usage = recorded.usage;
  let claude = previous?.measurements.claude;
  if (reports?.length) {
    if (batch.source.harness !== "claude") return null;
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
  const total = usage.reduce((sum, record) => sum + record.inputTokens + record.outputTokens, 0);
  if (!isCount(total)) return null;
  return { stored, usage, total, hasGap: recorded.hasGap || (claude?.hasGap ?? false) };
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
  if (!isRecordedTimestamp(at)) return null;
  const seconds = at.slice(17, 19);
  const tail = at.slice(19);
  const zoneStart = tail.search(/[z+-]/i);
  const zone = tail.slice(zoneStart);
  const offset = zone.length === 3 ? `${zone}:00` : zone;
  const second = Date.parse(`${at.slice(0, 10)}T${at.slice(11, 17)}${seconds === "60" ? "59" : seconds}${offset}`);
  if (!Number.isFinite(second)) return null;
  // Keep every fractional digit. A leap second follows every fraction of second 59.
  const fraction = (seconds === "60" ? "1" : "0") + tail.slice(1, zoneStart).replace(/0+$/, "");
  return { ...branch, instant: { second, fraction } };
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
  checkpoints: Map<string, Checkpoint>;
  view: Omit<SessionView, "messages">;
  messages: Map<string, StoredMessage>;
  measurements: StoredUsage;
  branches?: BranchHistory;
  hasGap: boolean;
}

function coverage(records: number, hasGap: boolean): Coverage {
  if (records === 0) return "unknown";
  return hasGap ? "partial" : "reported";
}

const diagnosticCodes = new Set(["invalid-claude-usage", "unidentified-claude-call", "unsupported-claude-cache-breakdown", "unsupported-claude-iteration"]);

function diagnosticKey(value: SourceUsageDiagnostic): string {
  return JSON.stringify([value.streamId, value.installationId, value.sourceOrder, value.code]);
}

function mergeDiagnostics(previous: SourceUsageDiagnostic[] | undefined, batch: Batch): SourceUsageDiagnostic[] | undefined | null {
  const incoming = batch.usageDiagnostics;
  if (incoming === undefined) return previous;
  if (!Array.isArray(incoming)) return null;
  if (!incoming.length) return previous;
  if (batch.source.harness !== "claude") return null;
  const diagnostics = new Map(previous?.map(value => [diagnosticKey(value), value]));
  const { streamId, installationId } = batch.source;
  for (const entry of incoming) {
    if (!isRecord(entry) || !isRecordNumber(entry.sourceOrder) || !diagnosticCodes.has(entry.code)) return null;
    const value = { streamId, ...(installationId !== undefined && { installationId }), sourceOrder: entry.sourceOrder, code: entry.code };
    diagnostics.set(diagnosticKey(value), value);
  }
  return [...diagnostics.values()];
}

function mergeSessionRecords(
  previous: StoredSession | undefined, batch: Batch, stream: string,
): Omit<StoredSession, "version" | "checkpoints"> | null {
  if (!hasValidMetadata(batch.metadata) || !Array.isArray(batch.messages)) return null;
  const messages = mergeMessages(previous?.messages, batch.messages, stream);
  const measurements = mergeMeasurements(previous, batch, stream);
  const branches = mergeBranches(previous?.branches, batch, stream);
  const usageDiagnostics = mergeDiagnostics(previous?.view.usageDiagnostics, batch);
  if (!messages || !measurements || branches === null || usageDiagnostics === null) return null;
  const { usage, total, stored } = measurements;
  const hasGap = previous?.hasGap === true || batch.hasGap === true || measurements.hasGap;
  const metadata = { ...previous?.view.metadata, ...definedFields(batch.metadata ?? {}) };
  if (branches) metadata.branch = branches.latest.name;
  const view = {
    key: { harness: batch.source.harness, sessionId: batch.source.sessionId }, metadata, usage,
    coverage: coverage(usage.length, hasGap), observedTotalTokens: usage.length ? total : null,
    ...(usageDiagnostics && { usageDiagnostics }),
  };
  return { view, messages, measurements: stored, branches, hasGap };
}

function parseState(state: string): unknown {
  try { return JSON.parse(state || "{}"); } catch { return null; }
}

function parserEnvelope(value: unknown, version: number, offset: number) {
  if (!isRecord(value) || value.version !== version || !isCount(value.lineNumber)
    || value.lineNumber < 1 || value.lineNumber > offset || !isRecord(value.decoder)) return null;
  return { lineNumber: value.lineNumber, decoder: value.decoder };
}

function upgradedChat(harness: Harness, decoder: Record<string, unknown>) {
  if (harness === "codex") {
    if (Object.keys(decoder).length === 2 && isRecord(decoder.chat) && isRecord(decoder.usage)) return decoder.chat;
  } else if (harness === "claude" && Object.keys(decoder).length === 1 && isRecord(decoder.occurrences)) {
    const valid = Object.entries(decoder.occurrences).every(([digest, count]) => /^[a-f0-9]{64}$/.test(digest)
      && isCount(count) && count > 0);
    if (valid) return decoder;
  }
}

function upgradesParser(harness: Harness, current: Checkpoint, next: Checkpoint): boolean {
  const state = parserEnvelope(parseState(next.parserState), 2, current.offset);
  if (!state) return false;
  const chat = upgradedChat(harness, state.decoder);
  if (!chat) return false;
  const old = parseState(current.parserState);
  if (isRecord(old) && Object.keys(old).length === 0) return true;
  const before = parserEnvelope(old, 1, current.offset);
  return before !== null && state.lineNumber === before.lineNumber && isDeepStrictEqual(chat, before.decoder);
}

function checkpointFailure(batch: Batch, current: Checkpoint | undefined): "invalid" | "conflict" | undefined {
  const { checkpoint, upgradeFromParserState } = batch;
  if (!isRecord(checkpoint) || !isCount(checkpoint.offset) || typeof checkpoint.parserState !== "string") return "invalid";
  if (upgradeFromParserState === undefined) return checkpoint.offset > (current?.offset ?? 0) ? undefined : "invalid";
  if (!current || checkpoint.offset !== current.offset || typeof upgradeFromParserState !== "string") return "invalid";
  if (current.parserState !== upgradeFromParserState) return "conflict";
  if (batch.messages?.length || batch.branchObservation !== undefined
    || Object.values(batch.metadata ?? {}).some(value => value !== undefined)) return "invalid";
  if (!upgradesParser(batch.source.harness, current, checkpoint)) return "invalid";
}

export class InMemoryCollectorStorage implements CollectorStorage {
  private readonly sessions = new Map<string, StoredSession>();

  async readCheckpoint(source: StreamKey): Promise<CheckpointSnapshot> {
    const session = this.sessions.get(encodeSessionKey(source));
    const checkpoint = session?.checkpoints.get(encodeStreamKey(source)) ?? null;
    return { version: session?.version ?? 0, checkpoint: structuredClone(checkpoint) };
  }

  async readSession(key: SessionKey): Promise<SessionView | null> {
    const stored = this.sessions.get(encodeSessionKey(key));
    return stored ? structuredClone({ ...stored.view, messages: orderedMessages(stored.messages) }) : null;
  }

  async commit(batch: Batch): Promise<CommitResult> {
    const { source, expectedVersion, expectedOffset } = batch;
    if (!isIdentifier(source.sessionId) || !isIdentifier(source.streamId)
      || (source.installationId !== undefined && !isIdentifier(source.installationId))) return "invalid";
    if (!isCount(expectedVersion) || !isCount(expectedOffset)) return "invalid";
    const session = encodeSessionKey(source);
    const stream = encodeStreamKey(source);
    // Compare both values and publish the complete session in one synchronous turn.
    const previous = this.sessions.get(session);
    const currentVersion = previous?.version ?? 0;
    const current = previous?.checkpoints.get(stream);
    if (expectedVersion !== currentVersion || expectedOffset !== (current?.offset ?? 0)) return "conflict";
    const version = currentVersion + 1;
    if (!isCount(version)) return "invalid";
    const failure = checkpointFailure(batch, current);
    if (failure) return failure;
    const incoming = structuredClone(batch);
    const records = mergeSessionRecords(previous, incoming, stream);
    if (!records) return "invalid";
    const checkpoints = new Map(previous?.checkpoints);
    checkpoints.set(stream, incoming.checkpoint);
    this.sessions.set(session, { version, checkpoints, ...records });
    return "committed";
  }
}
