import type { Batch, Harness, SourceUsageDiagnostic, UsageDiagnosticCode } from "./collector-storage.ts";
import { isByteRange, isCount, isRecord } from "./usage-validation.ts";

const rules: Record<UsageDiagnosticCode, { provider?: Harness; reportsGap?: true }> = {
  "invalid-claude-usage": { provider: "claude" },
  "unidentified-claude-call": { provider: "claude" },
  "unsupported-claude-cache-breakdown": { provider: "claude" },
  "unsupported-claude-iteration": { provider: "claude" },
  "ambiguous-transcript-replay": {},
  "unverified-source-history": {},
  "malformed-transcript-line": { reportsGap: true },
  "unsupported-codex-usage": { provider: "codex", reportsGap: true },
  "codex-counter-reset": { provider: "codex", reportsGap: true },
  "unresolved-codex-fork": { provider: "codex", reportsGap: true },
  "unresolved-claude-fork": { provider: "claude", reportsGap: true },
  "ambiguous-codex-call": { provider: "codex", reportsGap: true },
  "ambiguous-claude-iteration": { provider: "claude", reportsGap: true },
};

export class SourceUsageDiagnostics {
  private readonly entries = new Map<string, SourceUsageDiagnostic>();
  private readonly rangedLines = new Set<string>();

  static combine(...groups: SourceUsageDiagnostic[][]): SourceUsageDiagnostic[] {
    const records = new SourceUsageDiagnostics();
    for (const group of groups) for (const row of group) records.add(row);
    return [...records.entries.values()];
  }

  static merge(previous: SourceUsageDiagnostic[] | undefined, batch: Batch) {
    const incoming = batch.usageDiagnostics;
    if (incoming === undefined) return { values: previous, hasGap: false };
    if (!Array.isArray(incoming)) return null;
    if (!incoming.length) return { values: previous, hasGap: false };
    const records = new SourceUsageDiagnostics();
    for (const diagnostic of previous ?? []) records.add(diagnostic);
    const { streamId, installationId, harness } = batch.source;
    let hasGap = false;
    for (const entry of incoming) {
      if (!isRecord(entry) || !isCount(entry.sourceOrder) || entry.sourceOrder === 0) return null;
      const { code, sourceOrder, byteRange } = entry;
      if (typeof code !== "string" || !Object.hasOwn(rules, code)) return null;
      const rule = rules[code];
      if (rule.provider && harness !== rule.provider) return null;
      if (rule.reportsGap || byteRange !== undefined) {
        if (!isByteRange(byteRange, batch.checkpoint.offset)) return null;
      }
      // Workspace ownership supplies the current status, including parent evidence from other installations.
      if (code === "unresolved-claude-fork") continue;
      records.add({
        streamId, ...(installationId !== undefined && { installationId }), code, sourceOrder,
        ...(byteRange && { byteRange: { startOffset: byteRange.startOffset, endOffset: byteRange.endOffset } }),
      });
      hasGap ||= rule.reportsGap === true || code === "unverified-source-history";
    }
    return { values: records.entries.size ? [...records.entries.values()] : previous, hasGap };
  }

  private add(diagnostic: SourceUsageDiagnostic): void {
    const { streamId, installationId, sourceOrder, code, byteRange } = diagnostic;
    const line = JSON.stringify([streamId, installationId, sourceOrder, code]);
    if (!byteRange) {
      if (!this.rangedLines.has(line)) this.entries.set(line, diagnostic);
      return;
    }
    // Enrich the old line-only diagnostic. A rewrite can put a different damaged range on that same line.
    this.entries.delete(line);
    this.rangedLines.add(line);
    const position = JSON.stringify([line, byteRange.startOffset, byteRange.endOffset]);
    this.entries.set(position, diagnostic);
  }
}
