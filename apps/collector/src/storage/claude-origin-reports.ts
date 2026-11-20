import type { Batch, ClaudeCallOrigin, ClaudeUsageReport, StreamKey, Usage } from "./collector-storage.ts";
import { isByteRange } from "./usage-validation.ts";

export type ClaudeIdentity = Pick<ClaudeUsageReport, "messageId" | "requestId" | "iterationId">;
export type LocatedOrigin = ClaudeCallOrigin & Pick<StreamKey, "streamId" | "installationId">;
export interface Observation {
  readonly report: ClaudeUsageReport;
  readonly origin?: LocatedOrigin;
  readonly callKey: string;
}

export interface NativeCall extends ClaudeIdentity {
  readonly key: string;
  readonly origins: LocatedOrigin[];
}

function identity({ messageId, requestId, iterationId }: ClaudeIdentity): string {
  return JSON.stringify([messageId, requestId, iterationId]);
}

function groupKey(report: ClaudeUsageReport, origin: LocatedOrigin | undefined, ordinal: string): string {
  // Only a full pair can group observations before attribution. Two genuine requests can share one provider ID.
  if (report.messageId && report.requestId) return identity(report);
  return JSON.stringify([identity(report), origin?.transcriptUuid ?? ordinal]);
}

function originKey(row: ClaudeCallOrigin): string {
  return JSON.stringify([row.kind, row.parentSessionId, row.parentMessageUuid, row.transcriptUuid,
    row.sourceOrder, row.byteRange.startOffset, row.byteRange.endOffset]);
}

function collect(records: Map<string, Observation>, incoming: ClaudeUsageReport, source: StreamKey): boolean {
  const { origin: native, ...data } = incoming;
  const sourceKey = JSON.stringify([source.streamId, source.installationId]);
  const reportKey = JSON.stringify([data.at, data.messageId, data.requestId, data.iterationId, data.status, data.inputTokens, data.outputTokens,
    data.cacheReadTokens, data.cacheWriteTokens, data.cacheWrite5mTokens, data.cacheWrite1hTokens, data.reasoningTokens, data.turnId, data.model]);
  const unlocated = JSON.stringify([sourceKey, reportKey]);
  const first = records.get(unlocated);
  let key = unlocated;
  let origin: LocatedOrigin | undefined;
  if (native) {
    origin = { ...native, byteRange: { ...native.byteRange }, streamId: source.streamId, installationId: source.installationId };
    if (first?.origin) {
      const position = originKey(native);
      if (originKey(first.origin) === position) return false;
      key = JSON.stringify([unlocated, position]);
      if (records.has(key)) return false;
    }
  } else if (first) {
    return false;
  }
  // Upgrade the first unlocated observation in place to keep its original position across installations.
  records.set(key, { report: data, origin, callKey: groupKey(data, origin, key) });
  return true;
}

function originalIn(groups: ReadonlySet<NativeCall>, call: ClaudeIdentity): NativeCall | null {
  let result: NativeCall | undefined;
  for (const candidate of groups) {
    const agrees = call.messageId && candidate.messageId ? call.messageId === candidate.messageId
      : !!call.requestId && call.requestId === candidate.requestId;
    if (!agrees) return null;
    if (result && ((result.messageId && candidate.messageId && result.messageId !== candidate.messageId)
      || (result.requestId && candidate.requestId && result.requestId !== candidate.requestId))) return null;
    if (!result || (candidate.messageId && candidate.requestId)) result = candidate;
  }
  return result ?? null;
}

/** Preserve row identity even when the local numbers are disputed or a single-ID report is ambiguous. */
export class ClaudeOriginReports {
  readonly calls = new Map<string, NativeCall>();
  readonly rawIds: ReadonlySet<string>;
  private readonly uuids = new Map<string, Set<NativeCall>>();

  private constructor(readonly parents: ReadonlySet<string>, private readonly observations: ReadonlyMap<string, Observation>,
    usage: readonly Usage[]) {
    this.rawIds = new Set(usage.map(row => row.id));
    for (const { callKey, report, origin } of this.rows) {
      const { messageId, requestId, iterationId } = report;
      let call = this.calls.get(callKey);
      if (!call) {
        call = { key: callKey, messageId, requestId, iterationId, origins: [] };
        this.calls.set(callKey, call);
      }
      if (!origin) continue;
      call.origins.push(origin);
      if (!origin.transcriptUuid) continue;
      const uuid = JSON.stringify([origin.transcriptUuid, iterationId]);
      const groups = this.uuids.get(uuid) ?? new Set();
      groups.add(call);
      this.uuids.set(uuid, groups);
    }
  }

  get rows() { return this.observations.values(); }

  static merge(previous: ClaudeOriginReports | undefined, batch: Batch, usage: readonly Usage[], parentSessionId?: string) {
    const reports = batch.claudeUsageReports ?? [];
    const sameIds = previous?.rawIds.size === usage.length && usage.every(row => previous.rawIds.has(row.id));
    if (previous && sameIds && !reports.length && (!parentSessionId || previous.parents.has(parentSessionId))) return previous;
    const records = new Map(previous?.observations);
    const parents = new Set(previous?.parents);
    if (parentSessionId) parents.add(parentSessionId);
    let observed = false;
    for (const report of reports) {
      const { origin } = report;
      if (origin && !isByteRange(origin.byteRange, batch.checkpoint.offset)) return null;
      if (origin?.parentSessionId) parents.add(origin.parentSessionId);
      if (collect(records, report, batch.source)) observed = true;
    }
    if (!observed && previous && sameIds && parents.size === previous.parents.size) return previous;
    return new ClaudeOriginReports(parents, records, usage);
  }

  get parentId(): string | undefined {
    return this.parents.size === 1 ? this.parents.values().next().value : undefined;
  }

  /** A cited row can corroborate a rewritten request. An uncited call needs both provider IDs. */
  match(call: ClaudeIdentity, row?: LocatedOrigin): NativeCall | null | undefined {
    const uuid = row?.parentMessageUuid ?? row?.transcriptUuid;
    if (uuid) {
      const originals = this.uuids.get(JSON.stringify([uuid, call.iterationId]));
      if (originals) return originalIn(originals, call);
    }
    if (call.messageId && call.requestId) return this.calls.get(identity(call));
  }
}
