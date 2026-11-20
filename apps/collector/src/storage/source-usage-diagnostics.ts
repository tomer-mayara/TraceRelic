import type { Batch, ByteRange, Harness, SourceUsageDiagnostic, UsageDiagnosticCode } from "./collector-storage.ts";
import { isCount, isRecord } from "./usage-validation.ts";

const rules: Record<UsageDiagnosticCode, { provider?: Harness; reportsGap?: true }> = {
  "invalid-claude-usage": { provider: "claude" },
  "unidentified-claude-call": { provider: "claude" },
  "unsupported-claude-cache-breakdown": { provider: "claude" },
  "unsupported-claude-iteration": { provider: "claude" },
  "ambiguous-transcript-replay": {},
  "malformed-transcript-line": { reportsGap: true },
  "unsupported-codex-usage": { provider: "codex", reportsGap: true },
  "codex-counter-reset": { provider: "codex", reportsGap: true },
  "unresolved-codex-fork": { provider: "codex", reportsGap: true },
};

function validRange(range: unknown, acceptedEnd: number): range is ByteRange {
  return isRecord(range) && isCount(range.startOffset) && isCount(range.endOffset)
    && range.startOffset < range.endOffset && range.endOffset <= acceptedEnd;
}

export class SourceUsageDiagnostics {
  private readonly entries = new Map<string, SourceUsageDiagnostic>();
  private readonly rangedLines = new Set<string>();

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
        if (!validRange(byteRange, batch.checkpoint.offset)) return null;
      }
      records.add({
        streamId, ...(installationId !== undefined && { installationId }), code, sourceOrder,
        ...(byteRange && { byteRange: { startOffset: byteRange.startOffset, endOffset: byteRange.endOffset } }),
      });
      hasGap ||= rule.reportsGap === true;
    }
    return { values: [...records.entries.values()], hasGap };
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
