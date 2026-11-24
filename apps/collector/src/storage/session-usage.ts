import { isDeepStrictEqual } from "node:util";
import type { Batch, SourceUsageDiagnostic, StreamKey, Usage, UsageAnchor } from "./collector-storage.ts";
import { CodexCallAliases, type CodexUsageInput } from "./codex/codex-call-aliases.ts";
import { ClaudeUsageLedger } from "./claude/claude-usage-ledger.ts";
import { BatchValues } from "./batch-values.ts";
import { UsageWindows } from "./codex/usage-windows.ts";

interface StoredAnchor {
  stream: string;
  source: StreamKey;
  generation: number;
  anchor: UsageAnchor;
}

type UsageInput = CodexUsageInput & Pick<Batch, "claudeUsageReports">;

/** Retain each observation with its source generation so a verified repair can replace just that evidence. */
export interface UsageWrite {
  previous?: UsageWrite;
  input: UsageInput;
  stream: string;
  generation: number;
}

export interface StoredUsage {
  standalone: Usage[];
  anchors: Map<string, StoredAnchor[]>;
  windows: UsageWindows;
  claude?: ClaudeUsageLedger;
  order?: ReadonlySet<string>;
  aliases?: CodexCallAliases;
  ambiguous?: Map<string, SourceUsageDiagnostic | undefined>;
  possibleAliases?: ReadonlySet<string>;
}

interface MeasurementState {
  measurements: StoredUsage;
  usageWrites?: UsageWrite;
  view: { usage: Usage[] };
}

/** Keep the usage measurements of a session and the writes that supplied them. */
export class SessionUsage {
  private static mergeUsage(previous: readonly Usage[], incoming: readonly Usage[], codexCalls: ReadonlySet<string> | undefined): Usage[] | null {
    const records = new Map(previous.map((usage) => [usage.id, usage]));
    for (const entry of incoming) {
      if (!BatchValues.isUsage(entry)) return null;
      const usage = BatchValues.definedFields(entry);
      const existing = records.get(usage.id);
      if (existing?.revision === usage.revision && !isDeepStrictEqual(existing, usage)) {
        const merged = codexCalls?.has(usage.id) && BatchValues.mergeCodexCall(existing, usage);
        if (!merged) return null;
        records.set(usage.id, merged);
      } else if (!existing || usage.revision > existing.revision) records.set(usage.id, usage);
    }
    return [...records.values()];
  }

  private static rememberUsage(previous: UsageWrite | undefined, batch: UsageInput, stream: string, generation: number) {
    const { source, usage, usageWindows, usageAnchors, codexCallAliases, claudeUsageReports } = batch;
    if (!usage.length && !usageWindows?.length && !usageAnchors?.length && !codexCallAliases?.length && !claudeUsageReports?.length) return previous;
    return { previous, input: { source, usage, usageWindows, usageAnchors, codexCallAliases, claudeUsageReports }, stream, generation };
  }

  private static mergeAnchors(previous: Map<string, StoredAnchor[]> | undefined, batch: UsageInput, stream: string, generation: number) {
    const anchors = new Map(previous);
    if (!batch.usageAnchors?.length) return anchors;
    const calls = new Set(batch.usage.filter(record => record?.kind === "call").map(record => record.id));
    for (const anchor of batch.usageAnchors) {
      if (!BatchValues.isRecord(anchor) || !BatchValues.isIdentifier(anchor.usageId) || !calls.has(anchor.usageId) || !BatchValues.isIdentifier(anchor.historyId)
        || (anchor.after !== undefined && !BatchValues.isTokenCounts(anchor.after))) return null;
      const known = anchors.get(anchor.usageId) ?? [];
      if (known.some(entry => entry.generation === generation && entry.stream === stream
        && isDeepStrictEqual(entry.anchor, anchor))) continue;
      anchors.set(anchor.usageId, [...known, { source: batch.source, stream, generation, anchor }]);
    }
    return anchors;
  }

  private static previousNativeAnchors(previous: MeasurementState | undefined, anchors: Map<string, StoredAnchor[]>,
    stream: string, generation: number): StoredAnchor[] {
    if (!previous || !anchors.size) return [];
    const accepted = new Set(previous.measurements.windows.pendingNativeIds);
    if (generation) {
      for (const call of previous.view.usage) {
        if (!BatchValues.isNativeCodexCall(call)) continue;
        const placements = anchors.get(call.id) ?? [];
        if (placements.some(entry => entry.generation < generation && entry.stream === stream)) accepted.add(call.id);
      }
    }
    return [...accepted].flatMap(id => anchors.get(id) ?? []);
  }

  private static mergeRecordedUsage(previous: MeasurementState | undefined, batch: UsageInput, stream: string, generation: number) {
    if (!Array.isArray(batch.usage) || (batch.usageWindows !== undefined && !Array.isArray(batch.usageWindows))
      || (batch.usageAnchors !== undefined && !Array.isArray(batch.usageAnchors))) return null;
    const anchors = SessionUsage.mergeAnchors(previous?.measurements.anchors, batch, stream, generation);
    if (!anchors) return null;
    const retained = batch.usageWindows?.length || batch.usageAnchors?.length ? SessionUsage.previousNativeAnchors(previous, anchors, stream, generation) : [];
    const windows = UsageWindows.merge(previous?.measurements.windows, batch.usageWindows ?? [], batch.source, generation, retained);
    if (!windows) return null;
    const parts = windows.measurements;
    const activeIds = new Set(parts.map(part => part.id));
    const codexCalls = batch.source.harness === "codex" ? new Set([...anchors.keys(), ...activeIds]) : undefined;
    const standalone = SessionUsage.mergeUsage(previous?.measurements.standalone ?? [], batch.usage, codexCalls);
    if (!standalone) return null;
    const visible = standalone.filter(call => activeIds.has(call.id) || !windows.mayCoverCall(anchors.get(call.id) ?? []));
    // Carry forward the first time and position only for IDs that survived this transaction.
    const incoming = [...visible, ...parts];
    const ids = new Set(incoming.map(record => record.id));
    const surviving = previous?.view.usage.filter(record => ids.has(record.id)) ?? [];
    const usage = SessionUsage.mergeUsage(surviving, incoming, codexCalls);
    if (!usage) return null;
    const hasGap = windows.hasGap || activeIds.size !== parts.length;
    return { stored: { standalone, anchors, windows }, usage, hasGap };
  }

  private static combineClaudeUsage(previous: MeasurementState | undefined, ordinary: Usage[], claude: ClaudeUsageLedger) {
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

  private static retainedWrites(writes: UsageWrite | undefined, exclude: boolean, stream: string, generation: number) {
    const retained: UsageWrite[] = [];
    for (let write = writes; write; write = write.previous) {
      if (!exclude || write.stream !== stream || write.generation !== generation) retained.push(write);
    }
    return retained.reverse();
  }

  private static validMeasurementInput(batch: Batch, stream: string, generation: number, aliases?: CodexCallAliases): boolean {
    const arrays = [batch.claudeUsageReports, batch.usageWindows, batch.usageAnchors];
    if (!Array.isArray(batch.usage) || !CodexCallAliases.valid(batch) || arrays.some(rows => rows !== undefined && !Array.isArray(rows))) return false;
    if (!aliases && !batch.codexCallAliases?.length) return true;
    return batch.usage.every(BatchValues.isUsage) && !batch.usageWindows?.some(window => !UsageWindows.isWindow(window))
      && SessionUsage.mergeAnchors(undefined, batch, stream, generation) !== null;
  }

  private static replayMeasurements(retained: UsageWrite[], batch: Batch, previous: MeasurementState | undefined) {
    const inputs = [...retained.map(write => write.input), batch];
    const aliases = inputs.some(input => input.codexCallAliases?.length) ? new CodexCallAliases(inputs, previous?.view.usage ?? []) : undefined;
    const ambiguous = new Map<string, SourceUsageDiagnostic | undefined>();
    let state: MeasurementState | undefined;
    let history: UsageWrite | undefined;
    let claude: ClaudeUsageLedger | undefined;
    for (const write of retained) {
      const input = aliases?.normalize(write.input, ambiguous) ?? write.input;
      const recorded = SessionUsage.mergeRecordedUsage(state, input, write.stream, write.generation);
      if (!recorded) return null;
      state = { measurements: recorded.stored, view: { usage: recorded.usage } };
      history = { ...write, previous: history };
      const reports = write.input.claudeUsageReports;
      if (reports?.length) claude = ClaudeUsageLedger.fromValidatedReports(claude, reports, batch.source.sessionId);
    }
    return { state, history, aliases, ambiguous, claude, replay: true, inputs };
  }

  private static priorMeasurements(previous: MeasurementState | undefined, batch: Batch, stream: string, generation: number) {
    const current = previous?.measurements;
    const repair = Boolean(batch.reconcileCodexForkFrom || batch.repairEvidenceFrom);
    const additions = batch.codexCallAliases?.filter(row => !current?.aliases?.includes(row));
    if (repair || additions?.some(row => current?.aliases?.reclassifies(row) || current?.possibleAliases?.has(row.aliasUsageId))) {
      return SessionUsage.replayMeasurements(SessionUsage.retainedWrites(previous?.usageWrites, repair, stream, generation), batch, previous);
    }
    const aliases = additions?.length ? new CodexCallAliases([batch], previous?.view.usage ?? [], current?.aliases) : current?.aliases;
    return { state: previous, history: previous?.usageWrites, aliases, ambiguous: new Map(current?.ambiguous),
      claude: current?.claude, replay: false, inputs: [batch] };
  }

  /** Collect only weaker IDs that a later observation can promote to a specific native call. */
  private static possibleAliases(inputs: UsageInput[], known?: ReadonlySet<string>) {
    const additions = inputs.flatMap(input => [...input.usage, ...(input.usageWindows ?? []).flatMap(window => window.parts)])
      .filter(row => row.kind === "call" && !row.responseId && (row.requestId || !BatchValues.isNativeCodexCall(row))).map(row => row.id);
    return additions.some(id => !known?.has(id)) ? new Set([...(known ?? []), ...additions]) : known;
  }

  private static preserveCallPositions(usage: Usage[], previous: readonly Usage[]): Usage[] {
    const remaining = new Map(usage.map(row => [row.id, row]));
    const kept: Usage[] = [];
    for (const old of previous) {
      const row = remaining.get(old.id);
      if (!row) continue;
      const sameCall = row.kind === "call" && old.kind === "call" && row.inputTokens === old.inputTokens && row.outputTokens === old.outputTokens;
      kept.push(sameCall ? { ...row, at: old.at } : row);
      remaining.delete(row.id);
    }
    return [...kept, ...remaining.values()];
  }

  static apply(previous: MeasurementState | undefined, batch: Batch, stream: string, generation: number) {
    if (!SessionUsage.validMeasurementInput(batch, stream, generation, previous?.measurements.aliases)) return null;
    const prior = SessionUsage.priorMeasurements(previous, batch, stream, generation);
    if (!prior) return null;
    const { aliases, ambiguous } = prior;
    const input = aliases?.normalize(batch, ambiguous) ?? batch;
    const recorded = SessionUsage.mergeRecordedUsage(prior.state, input, stream, generation);
    if (!recorded) return null;
    const history = SessionUsage.rememberUsage(prior.history, batch, stream, generation);
    const stored: StoredUsage = recorded.stored;
    stored.aliases = aliases;
    stored.ambiguous = ambiguous;
    let usage = recorded.usage;
    if (batch.source.harness === "codex") {
      stored.possibleAliases = SessionUsage.possibleAliases(prior.inputs, prior.replay ? undefined : previous?.measurements.possibleAliases);
      if (prior.replay && previous) usage = SessionUsage.preserveCallPositions(usage, previous.view.usage);
    }
    let claude = prior.claude;
    const reports = batch.claudeUsageReports;
    if (reports?.length) {
      if (batch.source.harness !== "claude" || (batch.checkpoint.claudeCallOrigins && reports.some(report => !report?.origin))) return null;
      const next = ClaudeUsageLedger.merge(claude, reports, batch.source.sessionId);
      if (!next) return null;
      claude = next;
    }
    if (claude) {
      const combined = SessionUsage.combineClaudeUsage(previous, usage, claude);
      if (!combined) return null;
      usage = combined.usage;
      stored.order = combined.order;
      stored.claude = claude;
    }
    return { stored, usage, history, hasGap: recorded.hasGap || ambiguous.size > 0 };
  }
}
