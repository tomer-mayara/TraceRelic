import { isDeepStrictEqual } from "node:util";
import { ContractValues, type Batch, type Checkpoint, type CodexForkCheckpoint, type Harness } from "./collector-storage.ts";
import { BatchValues } from "./batch-values.ts";

const emptyPrefixDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** The change from the last accepted checkpoint of a source to the checkpoint of a batch, and the rules that accept the change. */
export class CheckpointTransition {
  constructor(private readonly batch: Batch, private readonly current: Checkpoint | undefined) {}

  private static parseState(state: string): unknown {
    try { return JSON.parse(state || "{}"); } catch { return null; }
  }

  private static parserEnvelope(value: unknown, version: number, offset: number) {
    if (!BatchValues.isRecord(value) || value.version !== version || !BatchValues.isCount(value.lineNumber)
      || value.lineNumber < 1 || value.lineNumber > offset || !BatchValues.isRecord(value.decoder)) return null;
    return { lineNumber: value.lineNumber, decoder: value.decoder };
  }

  private static upgradedChat(harness: Harness, decoder: Record<string, unknown>) {
    if (harness === "codex") {
      if (Object.keys(decoder).length === 2 && BatchValues.isRecord(decoder.chat) && BatchValues.isRecord(decoder.usage)) return decoder.chat;
    } else if (harness === "claude" && Object.keys(decoder).length === 1 && BatchValues.isRecord(decoder.occurrences)) {
      const valid = Object.entries(decoder.occurrences).every(([digest, count]) => ContractValues.isDigest(digest)
        && BatchValues.isCount(count) && count > 0);
      if (valid) return decoder;
    }
  }

  private static upgradesParser(harness: Harness, current: Checkpoint, next: Checkpoint): boolean {
    const parsed = CheckpointTransition.parseState(next.parserState);
    if (!BatchValues.isRecord(parsed)) return false;
    const pending = parsed.version === 4;
    const state = CheckpointTransition.parserEnvelope(parsed, pending ? 4 : 2, current.offset);
    if (!state) return false;
    const marker = BatchValues.isRecord(state.decoder.usage) ? state.decoder.usage.awaitingBaseline : undefined;
    if (parsed.replayOccurrences !== undefined || marker !== (pending ? true : undefined) || (pending && harness !== "codex")) return false;
    const chat = CheckpointTransition.upgradedChat(harness, state.decoder);
    if (!chat) return false;
    const old = CheckpointTransition.parseState(current.parserState);
    if (BatchValues.isRecord(old) && Object.keys(old).length === 0) return true;
    const before = CheckpointTransition.parserEnvelope(old, 1, current.offset);
    return before !== null && state.lineNumber === before.lineNumber && isDeepStrictEqual(chat, before.decoder);
  }

  private static isForkPosition(value: unknown): boolean {
    return BatchValues.isRecord(value) && BatchValues.isCount(value.offset) && BatchValues.isCount(value.lineNumber) && value.lineNumber > 0
      && (value.prefixDigest === undefined || ContractValues.isDigest(value.prefixDigest));
  }

  private static isForkCheckpoint(value: unknown): value is CodexForkCheckpoint {
    if (!BatchValues.isRecord(value) || !BatchValues.isIdentifier(value.parentSessionId)) return false;
    const { inheritedThrough, baseline, firstUncertain } = value;
    return (inheritedThrough === undefined || (firstUncertain === undefined && CheckpointTransition.isForkPosition(inheritedThrough)))
      && (firstUncertain === undefined || CheckpointTransition.isForkPosition(firstUncertain))
      && (baseline === undefined || (inheritedThrough !== undefined && BatchValues.isTokenCounts(baseline)));
  }

  private static isCheckpoint(value: unknown): value is Checkpoint {
    if (!BatchValues.isRecord(value) || !BatchValues.isCount(value.offset) || typeof value.parserState !== "string") return false;
    if (value.evidenceVersion !== undefined && (value.evidenceVersion !== 1 || typeof value.prefixDigest !== "string")) return false;
    const { prefixDigest, replayThrough, codexFork, claudeCallOrigins } = value;
    if (codexFork !== undefined && !CheckpointTransition.isForkCheckpoint(codexFork)) return false;
    if (claudeCallOrigins !== undefined && (claudeCallOrigins !== true || !ContractValues.isDigest(prefixDigest))) return false;
    if (prefixDigest === undefined) return replayThrough === undefined && codexFork === undefined;
    if (!ContractValues.isDigest(prefixDigest) || (value.offset === 0 && prefixDigest !== emptyPrefixDigest)) return false;
    return replayThrough === undefined || (BatchValues.isRecord(replayThrough) && BatchValues.isCount(replayThrough.offset)
      && replayThrough.offset > value.offset && ContractValues.isDigest(replayThrough.prefixDigest));
  }

  private static preservesReplayBound(current: Checkpoint | undefined, next: Checkpoint): boolean {
    const bound = current?.replayThrough;
    if (!bound || next.offset < bound.offset) return isDeepStrictEqual(next.replayThrough, bound);
    return next.replayThrough === undefined && (next.offset > bound.offset || next.prefixDigest === bound.prefixDigest);
  }

  private resetFailure(): "invalid" | "conflict" | undefined {
    const { batch, current } = this;
    const { checkpoint, resetFrom, upgradeFromParserState } = batch;
    if (!current || !CheckpointTransition.isCheckpoint(resetFrom) || checkpoint.prefixDigest === undefined || upgradeFromParserState !== undefined
      || batch.reconcileCodexForkFrom !== undefined || batch.backfillClaudeOriginsFrom !== undefined) return "invalid";
    if (!isDeepStrictEqual(BatchValues.definedFields(resetFrom), BatchValues.definedFields(current))) return "conflict";
  }

  private upgradeFailure(): "invalid" | "conflict" | undefined {
    const { batch, current } = this;
    const { checkpoint, upgradeFromParserState } = batch;
    if (!current || checkpoint.offset !== current.offset || typeof upgradeFromParserState !== "string") return "invalid";
    if (current.parserState !== upgradeFromParserState) return "conflict";
    if (current.prefixDigest !== undefined && checkpoint.prefixDigest !== current.prefixDigest) return "invalid";
    if (batch.messages?.length || batch.branchObservation !== undefined
      || Object.values(batch.metadata ?? {}).some(value => value !== undefined)) return "invalid";
    if (!CheckpointTransition.upgradesParser(batch.source.harness, current, checkpoint)) return "invalid";
  }

  private static backfillsClaudeOrigins(batch: Batch, current: Checkpoint): boolean {
    const { checkpoint } = batch;
    return checkpoint.claudeCallOrigins === true && current.claudeCallOrigins === undefined && batch.reconcileCodexForkFrom === undefined
      && Array.isArray(batch.usage) && !batch.usage.length && !batch.usageWindows?.length && !batch.usageAnchors?.length
      && (checkpoint.parserState === current.parserState || CheckpointTransition.upgradesParser("claude", current, checkpoint));
  }

  /** A correction may update only usage and its parent link at the accepted byte. */
  private correctionFailure(): "invalid" | "conflict" | undefined {
    const { batch, current } = this;
    const { checkpoint, reconcileCodexForkFrom, backfillClaudeOriginsFrom, metadata } = batch;
    const before = backfillClaudeOriginsFrom ?? reconcileCodexForkFrom;
    if (!current || !CheckpointTransition.isCheckpoint(before) || batch.upgradeFromParserState !== undefined) return "invalid";
    if (!isDeepStrictEqual(BatchValues.definedFields(before), BatchValues.definedFields(current))) return "conflict";
    if (checkpoint.offset !== current.offset || current.prefixDigest === undefined || checkpoint.prefixDigest !== current.prefixDigest
      || !isDeepStrictEqual(checkpoint.replayThrough, current.replayThrough)) return "invalid";
    if (batch.messages?.length || batch.branchObservation !== undefined || (metadata &&
      Object.keys(BatchValues.definedFields(metadata)).some(key => key !== "parentSessionId"))) return "invalid";
    if (backfillClaudeOriginsFrom !== undefined) return CheckpointTransition.backfillsClaudeOrigins(batch, current) ? undefined : "invalid";
    if (!checkpoint.codexFork || isDeepStrictEqual(checkpoint.codexFork, current.codexFork)) return "invalid";
  }

  private static belongsToSource(batch: Batch): boolean {
    const { checkpoint } = batch;
    if (checkpoint.claudeCallOrigins && batch.source.harness !== "claude") return false;
    const fork = checkpoint.codexFork;
    return !fork || (batch.source.harness === "codex" && (!fork.inheritedThrough || fork.parentSessionId !== batch.source.sessionId)
      && (batch.metadata?.parentSessionId === undefined || batch.metadata.parentSessionId === fork.parentSessionId));
  }

  private static preservesHistoricalLines(current: Checkpoint, next: Checkpoint): boolean {
    const before = CheckpointTransition.parseState(current.parserState);
    const after = CheckpointTransition.parseState(next.parserState);
    if (!BatchValues.isRecord(before) || !BatchValues.isRecord(after) || !BatchValues.isCount(after.version) || after.version < 2 || after.version > 4
      || !CheckpointTransition.parserEnvelope(after, after.version, next.offset)) return false;
    if (!Object.keys(before).length) return true;
    if (!BatchValues.isCount(before.version) || before.version < 1 || before.version > 4 || !CheckpointTransition.parserEnvelope(before, before.version, current.offset)
      || before.lineNumber !== after.lineNumber) return false;
    return isDeepStrictEqual(before.replayOccurrences ?? {}, after.replayOccurrences ?? {});
  }

  private evidenceFailure(): "invalid" | "conflict" | undefined {
    const { batch, current } = this;
    const { checkpoint } = batch;
    if (!current || !CheckpointTransition.isCheckpoint(batch.repairEvidenceFrom) || batch.resetFrom || batch.upgradeFromParserState !== undefined
      || batch.reconcileCodexForkFrom || batch.backfillClaudeOriginsFrom) return "invalid";
    if (!isDeepStrictEqual(BatchValues.definedFields(current), BatchValues.definedFields(batch.repairEvidenceFrom))) return "conflict";
    if (current.evidenceVersion || checkpoint.evidenceVersion !== 1 || !current.prefixDigest || !current.offset
      || current.offset !== checkpoint.offset || checkpoint.prefixDigest !== current.prefixDigest
      || !isDeepStrictEqual(current.replayThrough, checkpoint.replayThrough) || !CheckpointTransition.preservesHistoricalLines(current, checkpoint)) return "invalid";
  }

  private continuationFailure(): "invalid" | "conflict" | undefined {
    const { batch, current } = this;
    const { checkpoint } = batch;
    if (current && (current.offset > 0 || current.evidenceVersion) && checkpoint.evidenceVersion !== current.evidenceVersion) return "invalid";
    if (batch.reconcileCodexForkFrom !== undefined || batch.backfillClaudeOriginsFrom !== undefined) return this.correctionFailure();
    if (current?.codexFork?.inheritedThrough && !isDeepStrictEqual(checkpoint.codexFork, current.codexFork)) return "invalid";
    if (!CheckpointTransition.preservesReplayBound(current, checkpoint)) return "invalid";
    if (batch.upgradeFromParserState !== undefined) return this.upgradeFailure();
    if (current && (current.offset > 0 || current.claudeCallOrigins) && checkpoint.claudeCallOrigins !== current.claudeCallOrigins) return "invalid";
    return checkpoint.offset > (current?.offset ?? 0) ? undefined : "invalid";
  }

  failure(): "invalid" | "conflict" | undefined {
    const { batch, current } = this;
    const { checkpoint } = batch;
    if (!CheckpointTransition.isCheckpoint(checkpoint) || !CheckpointTransition.belongsToSource(batch) || (current?.prefixDigest !== undefined && checkpoint.prefixDigest === undefined)) return "invalid";
    if (batch.repairEvidenceFrom !== undefined) return this.evidenceFailure();
    if (batch.resetFrom !== undefined) return this.resetFailure();
    return this.continuationFailure();
  }
}
