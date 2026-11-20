import { isDeepStrictEqual } from "node:util";
import type { Batch, Checkpoint, CodexForkCheckpoint, Harness } from "./collector-storage.ts";
import { definedFields, isCount, isIdentifier, isRecord, isTokenCounts } from "./usage-validation.ts";

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
  const parsed = parseState(next.parserState);
  if (!isRecord(parsed)) return false;
  const pending = parsed.version === 4;
  const state = parserEnvelope(parsed, pending ? 4 : 2, current.offset);
  if (!state) return false;
  const marker = isRecord(state.decoder.usage) ? state.decoder.usage.awaitingBaseline : undefined;
  if (parsed.replayOccurrences !== undefined || marker !== (pending ? true : undefined) || (pending && harness !== "codex")) return false;
  const chat = upgradedChat(harness, state.decoder);
  if (!chat) return false;
  const old = parseState(current.parserState);
  if (isRecord(old) && Object.keys(old).length === 0) return true;
  const before = parserEnvelope(old, 1, current.offset);
  return before !== null && state.lineNumber === before.lineNumber && isDeepStrictEqual(chat, before.decoder);
}

const emptyPrefixDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function isPrefixDigest(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isForkPosition(value: unknown): boolean {
  return isRecord(value) && isCount(value.offset) && isCount(value.lineNumber) && value.lineNumber > 0
    && (value.prefixDigest === undefined || isPrefixDigest(value.prefixDigest));
}

function isForkCheckpoint(value: unknown): value is CodexForkCheckpoint {
  if (!isRecord(value) || !isIdentifier(value.parentSessionId)) return false;
  const { inheritedThrough, baseline, firstUncertain } = value;
  return (inheritedThrough === undefined || (firstUncertain === undefined && isForkPosition(inheritedThrough)))
    && (firstUncertain === undefined || isForkPosition(firstUncertain))
    && (baseline === undefined || (inheritedThrough !== undefined && isTokenCounts(baseline)));
}

function isCheckpoint(value: unknown): value is Checkpoint {
  if (!isRecord(value) || !isCount(value.offset) || typeof value.parserState !== "string") return false;
  const { prefixDigest, replayThrough, codexFork, claudeCallOrigins } = value;
  if (codexFork !== undefined && !isForkCheckpoint(codexFork)) return false;
  if (claudeCallOrigins !== undefined && (claudeCallOrigins !== true || !isPrefixDigest(prefixDigest))) return false;
  if (prefixDigest === undefined) return replayThrough === undefined && codexFork === undefined;
  if (!isPrefixDigest(prefixDigest) || (value.offset === 0 && prefixDigest !== emptyPrefixDigest)) return false;
  return replayThrough === undefined || (isRecord(replayThrough) && isCount(replayThrough.offset)
    && replayThrough.offset > value.offset && isPrefixDigest(replayThrough.prefixDigest));
}

function preservesReplayBound(current: Checkpoint | undefined, next: Checkpoint): boolean {
  const bound = current?.replayThrough;
  if (!bound || next.offset < bound.offset) return isDeepStrictEqual(next.replayThrough, bound);
  return next.replayThrough === undefined && (next.offset > bound.offset || next.prefixDigest === bound.prefixDigest);
}

function resetFailure(batch: Batch, current: Checkpoint | undefined): "invalid" | "conflict" | undefined {
  const { checkpoint, resetFrom, upgradeFromParserState } = batch;
  if (!current || !isCheckpoint(resetFrom) || checkpoint.prefixDigest === undefined || upgradeFromParserState !== undefined) return "invalid";
  if (!isDeepStrictEqual(definedFields(resetFrom), definedFields(current))) return "conflict";
}

function upgradeFailure(batch: Batch, current: Checkpoint | undefined): "invalid" | "conflict" | undefined {
  const { checkpoint, upgradeFromParserState } = batch;
  if (!current || checkpoint.offset !== current.offset || typeof upgradeFromParserState !== "string") return "invalid";
  if (current.parserState !== upgradeFromParserState) return "conflict";
  if (current.prefixDigest !== undefined && checkpoint.prefixDigest !== current.prefixDigest) return "invalid";
  if (batch.messages?.length || batch.branchObservation !== undefined
    || Object.values(batch.metadata ?? {}).some(value => value !== undefined)) return "invalid";
  if (!upgradesParser(batch.source.harness, current, checkpoint)) return "invalid";
}

function backfillsClaudeOrigins(batch: Batch, current: Checkpoint): boolean {
  const { checkpoint } = batch;
  return checkpoint.claudeCallOrigins === true && current.claudeCallOrigins === undefined && batch.reconcileCodexForkFrom === undefined
    && Array.isArray(batch.usage) && !batch.usage.length && !batch.usageWindows?.length && !batch.usageAnchors?.length
    && (checkpoint.parserState === current.parserState || upgradesParser("claude", current, checkpoint));
}

/** A correction may update only usage and its parent link at the accepted byte. */
function correctionFailure(batch: Batch, current: Checkpoint | undefined): "invalid" | "conflict" | undefined {
  const { checkpoint, reconcileCodexForkFrom, backfillClaudeOriginsFrom, metadata } = batch;
  const before = backfillClaudeOriginsFrom ?? reconcileCodexForkFrom;
  if (!current || !isCheckpoint(before)
    || batch.resetFrom !== undefined || batch.upgradeFromParserState !== undefined) return "invalid";
  if (!isDeepStrictEqual(definedFields(before), definedFields(current))) return "conflict";
  if (checkpoint.offset !== current.offset || current.prefixDigest === undefined || checkpoint.prefixDigest !== current.prefixDigest
    || !isDeepStrictEqual(checkpoint.replayThrough, current.replayThrough)) return "invalid";
  if (batch.messages?.length || batch.branchObservation !== undefined || (metadata &&
    Object.keys(definedFields(metadata)).some(key => key !== "parentSessionId"))) return "invalid";
  if (backfillClaudeOriginsFrom !== undefined) return backfillsClaudeOrigins(batch, current) ? undefined : "invalid";
  if (!checkpoint.codexFork || isDeepStrictEqual(checkpoint.codexFork, current.codexFork)) return "invalid";
}

function belongsToSource(batch: Batch): boolean {
  const { checkpoint } = batch;
  if (checkpoint.claudeCallOrigins && batch.source.harness !== "claude") return false;
  const fork = checkpoint.codexFork;
  return !fork || (batch.source.harness === "codex" && (!fork.inheritedThrough || fork.parentSessionId !== batch.source.sessionId)
    && (batch.metadata?.parentSessionId === undefined || batch.metadata.parentSessionId === fork.parentSessionId));
}

export function checkpointFailure(batch: Batch, current: Checkpoint | undefined): "invalid" | "conflict" | undefined {
  const { checkpoint } = batch;
  if (!isCheckpoint(checkpoint) || !belongsToSource(batch) || (current?.prefixDigest !== undefined && checkpoint.prefixDigest === undefined)) return "invalid";
  if (batch.reconcileCodexForkFrom !== undefined || batch.backfillClaudeOriginsFrom !== undefined) return correctionFailure(batch, current);
  if (batch.resetFrom !== undefined) return resetFailure(batch, current);
  if (current?.codexFork?.inheritedThrough && !isDeepStrictEqual(checkpoint.codexFork, current.codexFork)) return "invalid";
  if (!preservesReplayBound(current, checkpoint)) return "invalid";
  if (batch.upgradeFromParserState !== undefined) return upgradeFailure(batch, current);
  if (current && (current.offset > 0 || current.claudeCallOrigins) && checkpoint.claudeCallOrigins !== current.claudeCallOrigins) return "invalid";
  return checkpoint.offset > (current?.offset ?? 0) ? undefined : "invalid";
}
