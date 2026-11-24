import { SessionMessages } from "./session-messages.ts";
import { SessionMetadata } from "./session-metadata.ts";
import { isDeepStrictEqual } from "node:util";
import {
  legacyScannerLocation, sourceHistoryDiagnostic, type AcknowledgedSource, type Batch, type Checkpoint,
  type CheckpointSnapshot, type CollectorStorage, type CommitResult, type Coverage, type MissingSource, type PresenceWrite,
  type SessionKey, type SessionView, type SourceScope, type SourceUsageDiagnostic, type StreamKey, type Usage,
} from "./collector-storage.ts";
import { checkpointFailure } from "./checkpoint-transition.ts";
import { ClaudeCallOwners } from "./claude/claude-call-owners.ts";
import { CodexCallOwners } from "./codex/codex-call-owners.ts";
import { codexSourceIdentity } from "./codex/codex-source-identity.ts";
import { mergeMeasurements, type StoredUsage, type UsageWrite } from "./session-usage.ts";
import { StoredSource } from "./source-inventory.ts";
import { SourceUsageDiagnostics } from "./source-usage-diagnostics.ts";
import { isCount, isIdentifier, isRecord } from "./batch-values.ts";

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

interface StoredSession {
  version: number;
  checkpoints: Map<string, StoredSource>;
  view: Pick<SessionView, "key" | "metadata" | "usage" | "usageDiagnostics">;
  messages: SessionMessages;
  measurements: StoredUsage;
  usageWrites?: UsageWrite;
  sourceEvidence: Map<string, { hasGap: boolean; diagnostics?: SourceUsageDiagnostic[] }>;
  metadata: SessionMetadata;
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
  previous: StoredSession | undefined, batch: Batch, stream: string, source: StoredSource,
): Omit<StoredSession, "version" | "checkpoints"> | null {
  if (!Array.isArray(batch.messages)) return null;
  const { generation, lc17Evidence } = source;
  const messages = SessionMessages.apply(previous?.messages, batch, stream, generation);
  const measurements = mergeMeasurements(previous, batch, stream, generation);
  const sourceEvidence = new Map(previous?.sourceEvidence);
  const key = JSON.stringify([stream, generation]);
  const metadata = SessionMetadata.apply(previous?.metadata, batch, key, batch.expectedVersion + 1);
  let prior = batch.repairEvidenceFrom ? undefined : sourceEvidence.get(key);
  if (!lc17Evidence && batch.reconcileCodexForkFrom && prior?.diagnostics?.some(row => row.code === "unresolved-codex-fork")) {
    const remaining = prior.diagnostics.filter(row => row.code !== "unresolved-codex-fork");
    prior = { diagnostics: remaining, hasGap: prior.hasGap && remaining.length > 0 };
  }
  const diagnostics = SourceUsageDiagnostics.merge(prior?.diagnostics, batch);
  if (!messages || !measurements || !metadata || !diagnostics) return null;
  const { usage, stored } = measurements;
  sourceEvidence.set(key, { hasGap: prior?.hasGap === true || batch.hasGap === true || diagnostics.hasGap, diagnostics: diagnostics.values });
  const hasGap = measurements.hasGap || [...sourceEvidence.values()].some(value => value.hasGap);
  const values = SourceUsageDiagnostics.combine([...sourceEvidence.values()].flatMap(value => value.diagnostics ?? []),
    [...stored.ambiguous?.values() ?? []].filter((row): row is SourceUsageDiagnostic => row !== undefined));
  const view = {
    key: { harness: batch.source.harness, sessionId: batch.source.sessionId }, metadata: metadata.fields, usage,
    ...(values?.length && { usageDiagnostics: values }),
  };
  return { view, messages, measurements: stored, metadata, hasGap, usageWrites: measurements.history, sourceEvidence };
}

/** A write can advance the session that supplied the data and another session that owns a call. */
export interface SessionRevision extends SessionKey { version: number }

export class InMemoryCollectorStorage implements CollectorStorage {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly aliases = new Map<string, string>();
  private readonly codexOwners = new CodexCallOwners();
  private claudeOwners = new ClaudeCallOwners();

  async canonicalSource(source: StreamKey) { return this.aliases.get(encodeStreamKey(source)); }

  async mergeSourceAlias(source: StreamKey, target: string, version: number): Promise<boolean> {
    if (!source.installationId) return false;
    const key = encodeSessionKey(source), alias = encodeStreamKey(source);
    const registered = this.aliases.get(alias);
    if (registered !== undefined) return registered === target;
    const where = legacyScannerLocation(source.harness, source.streamId);
    const session = this.sessions.get(key);
    const left = session?.checkpoints.get(alias);
    const canonical = encodeStreamKey({ ...source, streamId: target });
    const right = session?.checkpoints.get(canonical);
    if (!where || where.path !== target || !session || session.version !== version || !left || !right || !left.sharesEvidence(right)) return false;
    const stored = left.selected(undefined, version);
    if (stored?.location.root !== where.root || stored.location.path !== where.path) return false;
    for (const stream of [alias, canonical]) {
      const evidence = session.sourceEvidence.get(JSON.stringify([stream, left.generation]));
      if (evidence?.hasGap || evidence?.diagnostics?.length) return false;
    }
    // Each source alone must corroborate the published records. Retire the redundant inputs so a later
    // verified repair of the canonical generation cannot resurrect text or calls under the old spelling.
    if (!this.withoutAliasEvidence(session, right)) return false;
    const retained = this.withoutAliasEvidence(session, left);
    if (!retained) return false;
    const checkpoints = new Map(session.checkpoints);
    checkpoints.delete(alias);
    retained.publish();
    this.sessions.set(key, { ...session, ...retained.records, checkpoints });
    this.aliases.set(alias, target);
    return true;
  }

  private withoutAliasEvidence(session: StoredSession, candidate: StoredSource) {
    const { checkpoint, source } = candidate;
    const remove: Batch = { source, expectedVersion: session.version, expectedOffset: checkpoint.offset,
      checkpoint, repairEvidenceFrom: checkpoint, messages: [], usage: [] };
    const records = mergeSessionRecords(session, remove, encodeStreamKey(source), candidate);
    if (!records || records.hasGap !== session.hasGap || !isDeepStrictEqual(records.view, session.view)
        || !isDeepStrictEqual(records.messages.ordered(), session.messages.ordered())) return;
    if (source.harness === "claude") {
      const ownership = this.claudeOwners.prepare(remove, records.measurements.claude?.measurements ?? [], undefined, candidate);
      if (!ownership || ownership.changedSessions.size) return;
      const before = this.claudeOwners.view(source.sessionId, session.view.usage, session.measurements.order);
      const after = ownership.owners.view(source.sessionId, records.view.usage, records.measurements.order);
      if (!isDeepStrictEqual(before, after)) return;
      return { records, publish: () => { this.claudeOwners = ownership.owners; } };
    }
    const ownership = this.codexOwners.prepare(remove, records.view.usage, id => this.verifiedParent(id, session), false, candidate);
    if (ownership === null || ownership?.transfers.size) return;
    if (ownership?.replacement) {
      const before = this.codexOwners.visible(source.sessionId, session.view.usage, session.measurements.aliases);
      const after = ownership.replacement.visible(source.sessionId, records.view.usage, records.measurements.aliases);
      if (!isDeepStrictEqual(before, after)) return;
    }
    return { records, publish: () => { if (ownership) this.codexOwners.publish(ownership); } };
  }

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

  readAcknowledgedSource(source: StreamKey): AcknowledgedSource | null {
    const session = this.sessions.get(encodeSessionKey(source));
    const row = session?.checkpoints.get(encodeStreamKey(source))?.selected(undefined, session.version);
    return structuredClone(row ?? null);
  }

  private saveSession(key: string, session: StoredSession, changed?: SessionRevision[]): void {
    this.sessions.set(key, session);
    changed?.push({ ...session.view.key, version: session.version });
  }

  /** The database calls this only while restoring writes that already committed. */
  restoreRevisions(revisions: readonly SessionRevision[]): void {
    for (const revision of revisions) {
      const key = encodeSessionKey(revision);
      const session = this.sessions.get(key);
      if (session && session.version !== revision.version) this.sessions.set(key, { ...session, version: revision.version });
    }
  }

  async recordPresence(update: PresenceWrite, changed?: SessionRevision[], lc17Journal = false): Promise<CommitResult> {
    if (!hasValidPosition(update)) return "invalid";
    const alias = this.aliases.get(encodeStreamKey(update.source));
    if (alias !== undefined) return this.recordPresence({ ...update, source: { ...update.source, streamId: alias } }, changed, lc17Journal);
    const key = encodeSessionKey(update.source);
    const stream = encodeStreamKey(update.source);
    const session = this.sessions.get(key);
    const current = session?.checkpoints.get(stream);
    if (!current || !session) return "invalid";
    if (session.version !== update.expectedVersion || current.checkpoint.offset !== update.expectedOffset) return "conflict";
    const repair = codexSourceIdentity(update, { file: current, messages: session.messages, stream, version: session.version },
      source => this.messageSource(source));
    if (typeof repair === "string") return repair;
    const next = current.record(update, repair.status, lc17Journal);
    if (!next) return "invalid";
    if (next === current) return "committed";
    const version = session.version + 1;
    if (!isCount(version) || (repair.advancePeer && !this.advancePeers(update.source, new Set([repair.advancePeer]), changed))) return "invalid";
    const checkpoints = new Map(session.checkpoints).set(stream, next);
    this.saveSession(key, { ...session, version, checkpoints, messages: repair.messages ?? session.messages }, changed);
    return "committed";
  }

  private messageSource(source: StreamKey) {
    const session = this.sessions.get(encodeSessionKey(source));
    if (!session) return;
    const alias = this.aliases.get(encodeStreamKey(source));
    const stream = encodeStreamKey(alias ? { ...source, streamId: alias } : source);
    return { version: session.version, messages: session.messages, stream, file: session.checkpoints.get(stream) };
  }

  async readCheckpoint(source: StreamKey): Promise<CheckpointSnapshot> {
    const alias = this.aliases.get(encodeStreamKey(source));
    if (alias !== undefined) return this.readCheckpoint({ ...source, streamId: alias });
    const session = this.sessions.get(encodeSessionKey(source));
    const stream = session?.checkpoints.get(encodeStreamKey(source));
    const observedThrough = stream?.observedThrough;
    return { version: session?.version ?? 0, checkpoint: structuredClone(stream?.checkpoint ?? null),
      ...(observedThrough && { observedThrough: structuredClone(observedThrough) }) };
  }

  async readSession(key: SessionKey): Promise<SessionView | null> {
    const stored = this.sessions.get(encodeSessionKey(key));
    if (!stored) return null;
    const { usage, diagnostics, hasGap } = key.harness === "claude" ? this.claudeOwners.view(key.sessionId, stored.view.usage, stored.measurements.order)
      : { usage: this.codexOwners.visible(key.sessionId, stored.view.usage, stored.measurements.aliases), diagnostics: [], hasGap: false };
    let partial = stored.hasGap || hasGap === true || diagnostics.length > 0;
    const missingSources: MissingSource[] = [];
    const historyDiagnostics: SourceUsageDiagnostic[] = [];
    for (const source of stored.checkpoints.values()) {
      partial ||= source.hasGap;
      if (source.unverifiedHistory || source.unverifiedIdentity) {
        historyDiagnostics.push(sourceHistoryDiagnostic(source.source));
        partial = true;
      }
      const missing = source.missing();
      if (missing) missingSources.push(missing);
    }
    return structuredClone({ ...stored.view, usage, messages: stored.messages.ordered(),
      coverage: coverage(usage.length, partial), observedTotalTokens: usage.length ? totalTokens(usage) : null,
      ...((diagnostics.length || historyDiagnostics.length) && {
        usageDiagnostics: SourceUsageDiagnostics.combine(stored.view.usageDiagnostics ?? [], diagnostics, historyDiagnostics),
      }),
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
  private advancePeers(source: SessionKey, transfers: ReadonlySet<string>, changed?: SessionRevision[],
    validUsage?: (peer: StoredSession) => boolean): boolean {
    const peers = new Map<string, StoredSession>();
    for (const id of transfers) {
      if (id === source.sessionId) continue;
      const key = encodeSessionKey({ harness: source.harness, sessionId: id });
      const stored = this.sessions.get(key);
      if (!stored) continue;
      if (!isCount(stored.version + 1) || (validUsage && !validUsage(stored))) return false;
      peers.set(key, { ...stored, version: stored.version + 1 });
    }
    for (const [key, updated] of peers) this.saveSession(key, updated, changed);
    return true;
  }

  private publishOwnership(batch: Batch, next: StoredSession, source: StoredSource, current: Checkpoint | undefined, changed?: SessionRevision[]): boolean {
    if (batch.source.harness === "claude") {
      if (batch.codexCallClaims !== undefined) return false;
      const staged = this.claudeOwners.prepare(batch, next.measurements.claude?.measurements ?? [], batch.metadata?.parentSessionId, source);
      if (!staged) return false;
      const validUsage = (session: StoredSession) => {
        const projected = staged.owners.view(session.view.key.sessionId, session.view.usage, session.measurements.order);
        return !projected.conflictingUsageId && isCount(totalTokens(projected.usage));
      };
      if (!validUsage(next) || !this.advancePeers(batch.source, staged.changedSessions, changed, validUsage)) return false;
      this.claudeOwners = staged.owners;
      return true;
    }
    if (!isCount(totalTokens(next.view.usage))) return false;
    const newProof = batch.checkpoint.codexFork?.inheritedThrough !== undefined &&
      !isDeepStrictEqual(batch.checkpoint.codexFork, current?.codexFork);
    const ownership = this.codexOwners.prepare(batch, next.view.usage, id => this.verifiedParent(id, next), newProof, source);
    if (ownership === null) return false;
    if (!ownership) return true;
    if (!this.advancePeers(batch.source, ownership.transfers, changed)) return false;
    this.codexOwners.publish(ownership);
    return true;
  }

  async commit(batch: Batch, changed?: SessionRevision[], lc17Journal = false): Promise<CommitResult> {
    if (!hasValidPosition(batch)) return "invalid";
    const alias = this.aliases.get(encodeStreamKey(batch.source));
    if (alias !== undefined) return this.commit({ ...batch, source: { ...batch.source, streamId: alias } }, changed, lc17Journal);
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
    const accepted = StoredSource.accept(current, incoming, generation, lc17Journal);
    if (!accepted) return "invalid";
    if (incoming.repairEvidenceFrom) {
      previous?.metadata.restoreBackupFields(incoming, JSON.stringify([stream, generation]), accepted.selected(undefined, version)?.location);
    }
    const records = mergeSessionRecords(previous, incoming, stream, accepted);
    if (!records) return "invalid";
    const checkpoints = new Map(previous?.checkpoints);
    checkpoints.set(stream, accepted);
    const next = { version, checkpoints, ...records };
    if (!this.publishOwnership(incoming, next, accepted, current?.checkpoint, changed)) return "invalid";
    this.saveSession(session, next, changed);
    return "committed";
  }
}
