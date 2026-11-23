import type { Batch, CodexCallAlias, SourceUsageDiagnostic, Usage } from "../collector-storage.ts";
import { BatchValues } from "../batch-values.ts";

export type CodexUsageInput = Pick<Batch, "source" | "usage" | "usageAnchors" | "usageWindows" | "codexCallAliases">;
type Witness = { call: string; diagnostic?: SourceUsageDiagnostic; closing?: CodexCallAlias["closing"] };

/** A request can identify a single call until a distinct native call proves that the request was shared. */
export class CodexCallAliases {
  private readonly witnesses: Map<string, Witness[]>;
  private readonly published: Map<string, string>;
  private readonly requests: Map<string, string>;
  private readonly disputed: Map<string, SourceUsageDiagnostic | undefined>;
  private readonly mirrors = new Map<string, Set<string>>();

  constructor(inputs: readonly CodexUsageInput[], previous: readonly Usage[], base?: CodexCallAliases) {
    this.witnesses = new Map(base?.witnesses);
    this.published = new Map(base?.published);
    this.requests = new Map(base?.requests);
    this.disputed = new Map(base?.disputed);
    for (const input of inputs) for (const row of input.codexCallAliases ?? []) this.addWitness(input.source, row);
    for (const group of this.witnesses.values()) this.matchClosing(group);
    for (const call of previous) this.reserve(call);
    for (const input of inputs) {
      for (const row of input.usage) this.reserve(row);
      for (const window of input.usageWindows ?? []) for (const row of window.parts) this.reserve(row);
    }
  }

  static valid(batch: Batch): boolean {
    const aliases = batch.codexCallAliases;
    return aliases === undefined || (batch.source.harness === "codex" && Array.isArray(aliases)
      && aliases.every(row => BatchValues.isRecord(row) && typeof row.callUsageId === "string" && /^call:native:[a-f0-9]{64}$/.test(row.callUsageId)
        && typeof row.aliasUsageId === "string" && /^call:(?:native:)?[a-f0-9]{64}$/.test(row.aliasUsageId)
        && (row.closing === undefined || (!row.aliasUsageId.startsWith("call:native:") && BatchValues.isTokenCounts(row.closing)
          && (row.closing.turnId === undefined || BatchValues.isIdentifier(row.closing.turnId))
          && (row.closing.responseId === undefined || BatchValues.isIdentifier(row.closing.responseId))))
        && row.callUsageId !== row.aliasUsageId && (row.sourceOrder === undefined && row.byteRange === undefined ||
          (BatchValues.isCount(row.sourceOrder) && row.sourceOrder > 0 && BatchValues.isByteRange(row.byteRange, batch.checkpoint.offset)))));
  }

  private addWitness(source: CodexUsageInput["source"], row: CodexCallAlias): void {
    const group = this.witnesses.get(row.aliasUsageId) ?? [];
    if (group.some(witness => witness.call === row.callUsageId)) return;
    const { sourceOrder, byteRange } = row;
    const { streamId, installationId } = source;
    const diagnostic = sourceOrder && byteRange ? { code: "ambiguous-codex-call" as const, sourceOrder, byteRange, streamId,
      ...(installationId !== undefined && { installationId }) } : undefined;
    if (row.aliasUsageId.startsWith("call:native:")) {
      const earlier = this.requests.get(row.callUsageId);
      if (earlier && earlier !== row.aliasUsageId) {
        this.disputed.set(row.callUsageId, diagnostic);
        this.published.delete(row.callUsageId);
      }
      this.requests.set(row.callUsageId, row.aliasUsageId);
    }
    this.witnesses.set(row.aliasUsageId, [...group, { call: row.callUsageId, diagnostic, closing: row.closing }]);
    if (group.length) {
      this.published.delete(group[0].call);
      this.published.delete(row.callUsageId);
    }
  }

  private matchClosing(group: Witness[]): void {
    if (group.length !== 2) return;
    const response = group.find(row => row.closing?.responseId);
    const legacy = group.find(row => row.closing && !row.closing.responseId);
    if (!response?.closing || !legacy?.closing) return;
    const a = response.closing, b = legacy.closing;
    if (a.inputTokens !== b.inputTokens || a.outputTokens !== b.outputTokens || (a.turnId && b.turnId && a.turnId !== b.turnId)) return;
    const matches = this.mirrors.get(legacy.call) ?? new Set<string>();
    this.mirrors.set(legacy.call, matches.add(response.call));
  }

  includes({ aliasUsageId, callUsageId }: CodexCallAlias): boolean {
    return this.witnesses.get(aliasUsageId)?.some(row => row.call === callUsageId) === true;
  }

  reclassifies({ aliasUsageId, callUsageId }: CodexCallAlias): boolean {
    if (!aliasUsageId.startsWith("call:native:")) return this.witnesses.has(aliasUsageId);
    const earlier = this.requests.get(callUsageId);
    return earlier !== undefined && earlier !== aliasUsageId;
  }

  private reserve(row: Usage): void {
    if (row.kind !== "call") return;
    const canonical = this.canonical(row.id);
    if (canonical && !this.published.has(canonical)) this.published.set(canonical, row.id);
  }

  canonical(id: string): string | undefined {
    const match = this.witnesses.get(id);
    const candidates = new Set<string>();
    for (const call of match?.map(row => row.call) ?? [id]) {
      if (match && this.disputed.has(call)) return;
      const mirrors = this.mirrors.get(call);
      if (mirrors && mirrors.size !== 1) return;
      candidates.add(mirrors ? [...mirrors][0] : call);
    }
    if (candidates.size === 1) return [...candidates][0];
  }

  private key(id: string): string | undefined {
    const canonical = this.canonical(id);
    return canonical && (this.published.get(canonical) ?? canonical);
  }

  normalize(input: CodexUsageInput, ambiguous: Map<string, SourceUsageDiagnostic | undefined>): CodexUsageInput {
    const resolve = (row: Usage): Usage[] => {
      if (row.kind !== "call") return [row];
      if (this.disputed.has(row.id)) {
        ambiguous.set(row.id, this.disputed.get(row.id));
        const { requestId: _, ...accepted } = row;
        return [accepted];
      }
      const id = this.key(row.id);
      if (id) return [id === row.id ? row : { ...row, id }];
      const witnesses = this.witnesses.get(row.id);
      ambiguous.set(row.id, witnesses?.[witnesses.length - 1]?.diagnostic);
      return [];
    };
    return { ...input, usage: input.usage.flatMap(resolve),
      usageAnchors: input.usageAnchors?.flatMap(row => {
        const id = this.key(row.usageId);
        return id ? [{ ...row, usageId: id }] : [];
      }),
      usageWindows: input.usageWindows?.map(window => ({ ...window, parts: window.parts.flatMap(row => {
        const candidate = resolve(row);
        if (candidate.length) return candidate;
        const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, at, revision } = row;
        return [{ id: "interval:" + row.id, kind: "interval" as const, at, revision,
          inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens }];
      }) })),
    };
  }
}
