import { isDeepStrictEqual } from "node:util";
import { TranscriptChangedError, type DamagedLine, type ReadPosition, type RecordBatch, type TranscriptSource, type VerifiedPrefix } from "../transcript/index.ts";
import type { Batch, Checkpoint, CodexForkCheckpoint, Message } from "../storage/collector-storage.ts";
import { stateRecord } from "./chat-parser-state.ts";
import type { ChatParser, DecodedChat, DecodedUsage } from "./decoded-chat.ts";
import {
  countReplayMessages, planReplayOccurrences, readReplayOccurrences, reconcileReplayMessages, type ReplayOccurrences,
} from "./transcript-replay.ts";

export interface ParserFormat<Entry> {
  version: number;
  gapVersion?: number;
  codexFork?: CodexForkCheckpoint;
  claudeCallOrigins?: true;
  resume(state?: unknown): ChatParser<Entry>;
  upgrade?(oldDecoder?: object): {
    parser: ChatParser<Entry>;
    read(entries: readonly Entry[], damagedLines?: readonly DamagedLine[]): Partial<DecodedUsage>;
  };
}

export type SourceLine = Pick<DamagedLine, "lineNumber" | "endOffset"> & { readonly recordPrefixDigest?: string };

interface ReplayPlan {
  occurrences?: ReplayOccurrences;
  through?: VerifiedPrefix;
}

const replayVersion = 3;

class BackfilledUsage implements DecodedUsage {
  readonly usage: DecodedUsage["usage"] = [];
  readonly usageAnchors: NonNullable<DecodedUsage["usageAnchors"]> = [];
  readonly usageWindows: DecodedUsage["usageWindows"] = [];
  readonly claudeUsageReports: NonNullable<DecodedUsage["claudeUsageReports"]> = [];
  codexCallClaims?: DecodedUsage["codexCallClaims"];
  codexCallAliases?: DecodedUsage["codexCallAliases"];
  readonly usageDiagnostics: NonNullable<DecodedUsage["usageDiagnostics"]> = [];
  hasGap = false;

  add(batch: Partial<DecodedUsage>): void {
    for (const record of batch.usage ?? []) this.usage.push(record);
    for (const anchor of batch.usageAnchors ?? []) this.usageAnchors.push(anchor);
    for (const window of batch.usageWindows ?? []) this.usageWindows.push(window);
    for (const report of batch.claudeUsageReports ?? []) this.claudeUsageReports.push(report);
    if (batch.codexCallClaims?.length) {
      const claims = this.codexCallClaims ??= [];
      for (const claim of batch.codexCallClaims) claims.push(claim);
    }
    if (batch.codexCallAliases?.length) {
      const aliases = this.codexCallAliases ??= [];
      for (const alias of batch.codexCallAliases) aliases.push(alias);
    }
    for (const diagnostic of batch.usageDiagnostics ?? []) this.usageDiagnostics.push(diagnostic);
    this.hasGap ||= batch.hasGap === true;
  }
}

function locateDiagnostics<Entry extends SourceLine>(batch: RecordBatch<Entry>, chat: Partial<DecodedUsage>): void {
  if (!chat.usageDiagnostics?.length && !batch.damagedLines?.length) return;
  const diagnostics = chat.usageDiagnostics ??= [];
  if (diagnostics.length) {
    const byLine = new Map(batch.entries.map(entry => [entry.lineNumber, entry]));
    for (const diagnostic of diagnostics) {
      const line = byLine.get(diagnostic.sourceOrder);
      if (line) diagnostic.byteRange = { startOffset: line.startOffset, endOffset: line.endOffset };
    }
  }
  for (const { lineNumber, startOffset, endOffset } of batch.damagedLines ?? []) {
    diagnostics.push({ code: "malformed-transcript-line", sourceOrder: lineNumber, byteRange: { startOffset, endOffset } });
    chat.hasGap = true;
  }
  diagnostics.sort((left, right) => left.sourceOrder - right.sourceOrder);
}

export class TranscriptCursor<Entry extends SourceLine> {
  private constructor(
    private readonly position: ReadPosition, private readonly format: ParserFormat<Entry>,
    private readonly parser: ChatParser<Entry>, private readonly replay?: ReplayPlan,
    private readonly backfill?: { usage: BackfilledUsage; checkpoint: Checkpoint },
  ) {}

  /** Decode only bytes proven to be the source of this installation's old checkpoint. */
  static async repairEvidence<Entry extends SourceLine>(
    source: TranscriptSource<Entry>, previous: Checkpoint, format: ParserFormat<Entry>,
  ): Promise<Omit<Batch, "source" | "expectedOffset" | "expectedVersion"> | undefined> {
    if (previous.evidenceVersion || !previous.offset || !previous.prefixDigest) return;
    const old = readState(previous, format, source.sourceFile);
    const end = previous.offset;
    const prefix: TranscriptSource<Entry> = { ...source, fileSize: end,
      readBatches: (position, size, through = end) => source.readBatches(position, size, Math.min(through, end)) };
    const cursor = new TranscriptCursor({ offset: 0, lineNumber: 0 }, format, format.resume(), old?.replay);
    const usage = new BackfilledUsage();
    const messages: Message[] = [];
    const messageOrigins: NonNullable<Batch["messageOrigins"]> = [];
    const metadata: NonNullable<Batch["metadata"]> = {};
    let branchObservation: Batch["branchObservation"];
    let checkpoint: Checkpoint | undefined;
    for await (const decoded of cursor.read(prefix)) {
      const { chat } = decoded;
      for (const message of chat.messages) messages.push(message);
      for (const origin of chat.messageOrigins ?? []) messageOrigins.push(origin);
      Object.assign(metadata, chat.metadata);
      branchObservation = chat.branchObservation ?? branchObservation;
      usage.add(chat);
      checkpoint = decoded.checkpoint;
    }
    if (checkpoint?.offset !== end || checkpoint.prefixDigest !== previous.prefixDigest
      || (old && JSON.parse(checkpoint.parserState).lineNumber !== old.lineNumber)) throw new TranscriptChangedError(source.sourceFile);
    return { ...usage, messages, ...(messageOrigins.length && { messageOrigins }), metadata, branchObservation,
      checkpoint, repairEvidenceFrom: previous };
  }

  /** Reclassify the accepted usage at its current byte while preserving chat and replay decisions. */
  static async reconcileUsage<Entry extends SourceLine>(
    source: TranscriptSource<Entry>, checkpoint: Checkpoint, format: ParserFormat<Entry>,
  ): Promise<Omit<Batch, "source" | "expectedOffset" | "expectedVersion"> | undefined> {
    const claude = format.claudeCallOrigins && !checkpoint.claudeCallOrigins && checkpoint.offset > 0;
    const fork = format.codexFork;
    if (!claude && (!fork || isDeepStrictEqual(fork, checkpoint.codexFork))) return;
    const saved = readState(checkpoint, format, source.sourceFile);
    const parser = format.resume();
    const usage = new BackfilledUsage();
    let parentSessionId = fork?.parentSessionId;
    let position = { offset: 0, lineNumber: 0 };
    let digest: string | undefined;
    for await (const batch of source.readBatches(position, undefined, checkpoint.offset)) {
      const chat = parser.decodeBatch(batch.entries, batch.damagedLines);
      parentSessionId ??= chat.metadata.parentSessionId;
      locateDiagnostics(batch, chat);
      usage.add(chat);
      position = batch.next;
      digest = batch.prefixDigest;
    }
    if (position.offset !== checkpoint.offset || digest !== checkpoint.prefixDigest
      || (saved && saved.lineNumber !== position.lineNumber)) throw new TranscriptChangedError(source.sourceFile);
    const records = { ...usage, messages: [], ...(parentSessionId && { metadata: { parentSessionId } }) };
    if (claude) {
      // Claude keeps its usage ledger in storage. An earlier decoder's chat state is authoritative.
      const chat = saved ? format.resume(saved.decoder) : parser;
      const next = saved && saved.version !== 1 ? { ...checkpoint, claudeCallOrigins: true as const }
        : new TranscriptCursor(position, format, chat, saved?.replay).checkpointAt(position, digest);
      return { ...records, checkpoint: next, backfillClaudeOriginsFrom: checkpoint };
    }
    const acceptedChat = saved?.version === 1 ? saved.decoder : saved?.decoder.chat;
    const restored = acceptedChat ? format.resume({ ...parser.snapshot(), chat: acceptedChat }) : parser;
    const cursor = new TranscriptCursor(position, format, restored, saved?.replay);
    return { ...records, checkpoint: cursor.checkpointAt(position, digest), reconcileCodexForkFrom: checkpoint };
  }

  static async restore<Entry extends SourceLine>(
    source: TranscriptSource<Entry>, checkpoint: Checkpoint | null, format: ParserFormat<Entry>,
    replayMessages?: readonly Message[],
  ): Promise<TranscriptCursor<Entry>> {
    let position = { offset: 0, lineNumber: 0 };
    if (!checkpoint) return new TranscriptCursor(position, format, format.resume());
    const invalid = `Cannot restore parser state for ${source.sourceFile} at byte ${checkpoint.offset}`;
    const saved = readState(checkpoint, format, source.sourceFile);
    if (replayMessages) return TranscriptCursor.rebuild(source, format, replayMessages);
    let upgrade: ReturnType<NonNullable<ParserFormat<Entry>["upgrade"]>> | undefined;
    let parser: ChatParser<Entry>;
    try {
      if (saved && saved.version !== 1) {
        const parser = format.resume(saved.decoder);
        if (Boolean(parser.awaitingBaseline) !== (saved.version === format.gapVersion)) throw new Error(invalid);
        return new TranscriptCursor({ offset: checkpoint.offset, lineNumber: saved.lineNumber },
          format, parser, saved.replay);
      }
      upgrade = format.upgrade?.(saved?.decoder);
      parser = upgrade?.parser ?? format.resume();
    } catch {
      throw new Error(invalid);
    }
    const backfill = upgrade ? new BackfilledUsage() : undefined;
    for await (const batch of source.readBatches(position, undefined, checkpoint.offset)) {
      if (upgrade && backfill) {
        const usage = upgrade.read(batch.entries, batch.damagedLines);
        locateDiagnostics(batch, usage);
        backfill.add(usage);
      } else parser.decodeBatch(batch.entries, batch.damagedLines);
      position = batch.next;
    }
    if (position.offset !== checkpoint.offset || (saved && position.lineNumber !== saved.lineNumber)) throw new Error(invalid);
    return new TranscriptCursor(position, format, parser, undefined, backfill && { usage: backfill, checkpoint });
  }

  private static async rebuild<Entry extends SourceLine>(source: TranscriptSource<Entry>, format: ParserFormat<Entry>, accepted: readonly Message[]) {
    const start = { offset: 0, lineNumber: 0 };
    const fresh = new TranscriptCursor(start, format, format.resume());
    if (!accepted.some(message => message.id.startsWith("text:"))) return fresh;
    // Count occurrences across the captured replacement before publishing any of its batches.
    const counts = new Map<string, number>();
    let through: VerifiedPrefix | undefined;
    for await (const { chat, next, prefixDigest } of fresh.decode(source)) {
      countReplayMessages(counts, chat.messages);
      through = { offset: next.offset, prefixDigest };
    }
    const bounds = planReplayOccurrences(accepted, counts);
    return new TranscriptCursor(start, format, format.resume(), {
      occurrences: Object.keys(bounds).length ? bounds : undefined, through,
    });
  }

  private async *decode(source: TranscriptSource<Entry>) {
    if (this.position.offset >= source.fileSize) return;
    let prepare = this.parser.prepareLookahead?.bind(this.parser);
    for await (const batch of source.readBatches(this.position)) {
      const { entries, next, prefixDigest } = batch;
      if (prepare && next.offset < source.fileSize) {
        await prepare(entries, source.readBatches(next), this.position.lineNumber, batch.damagedLines);
        prepare = undefined;
      }
      const chat = this.parser.decodeBatch(entries, batch.damagedLines);
      if (this.replay?.occurrences) reconcileReplayMessages(chat, this.replay.occurrences);
      if (chat.messages.length) {
        const visible = new Set(chat.messages.map(message => message.sourceOrder));
        const proofs = entries.flatMap(entry => entry.recordPrefixDigest && visible.has(entry.lineNumber)
          ? [{ sourceOrder: entry.lineNumber, prefixDigest: entry.recordPrefixDigest }] : []);
        if (proofs.length) chat.messageOrigins = [...chat.messageOrigins ?? [], ...proofs];
      }
      locateDiagnostics(batch, chat);
      yield { chat, next, prefixDigest };
    }
  }

  async *read(source: TranscriptSource<Entry>) {
    let backfill = this.backfill?.usage;
    let startOffset = backfill ? 0 : this.position.offset;
    for await (const { chat, next, prefixDigest } of this.decode(source)) {
      if (backfill) {
        backfill.add(chat);
        Object.assign(chat, backfill);
        backfill = undefined;
      }
      yield { chat, checkpoint: this.checkpointAt(next, prefixDigest), startOffset, upgrade: false };
      startOffset = next.offset;
    }
    if (backfill) {
      const chat: DecodedChat = { messages: [], metadata: {}, ...backfill };
      yield { chat, checkpoint: this.checkpointAt(this.position, this.backfill?.checkpoint.prefixDigest), startOffset, upgrade: true };
    }
  }

  private checkpointAt({ offset, lineNumber }: ReadPosition, prefixDigest?: string): Checkpoint {
    const through = this.replay?.through;
    const replayThrough = through && offset < through.offset ? through : undefined;
    const replayOccurrences = this.replay?.occurrences ?? (replayThrough ? {} : undefined);
    let version = replayOccurrences ? replayVersion : this.format.version;
    if (this.parser.awaitingBaseline && this.format.gapVersion !== undefined) version = this.format.gapVersion;
    const parserState = JSON.stringify({ version, lineNumber, decoder: this.parser.snapshot(), replayOccurrences });
    return { offset, parserState, prefixDigest, evidenceVersion: 1, ...(replayThrough && { replayThrough }),
      ...(this.format.claudeCallOrigins && { claudeCallOrigins: true }),
      ...(this.format.codexFork && { codexFork: this.format.codexFork }) };
  }
}

function readReplayPlan(state: Record<string, unknown>, checkpoint: Checkpoint, gapVersion?: number): ReplayPlan | undefined {
  const occurrences = readReplayOccurrences(state.replayOccurrences);
  const supportsRules = state.version === replayVersion || state.version === gapVersion;
  const requiresRules = state.version === replayVersion || checkpoint.replayThrough !== undefined;
  if (occurrences ? !supportsRules : requiresRules) throw new Error("Invalid replay state");
  if (occurrences) return {
    occurrences: Object.keys(occurrences).length ? occurrences : undefined, through: checkpoint.replayThrough,
  };
}

function readState<Entry>(checkpoint: Checkpoint, format: ParserFormat<Entry>, sourceFile: string) {
  const invalid = `Cannot restore parser state for ${sourceFile} at byte ${checkpoint.offset}`;
  let saved: Record<string, unknown>;
  try {
    saved = stateRecord(JSON.parse(checkpoint.parserState || "{}"));
  } catch {
    throw new Error(invalid);
  }
  if (Object.keys(saved).length === 0) return;
  const { version, lineNumber } = saved;
  if (!Number.isSafeInteger(version)) throw new Error(invalid);
  if (version !== format.version && version !== replayVersion && version !== format.gapVersion && !(format.upgrade && version === 1)) {
    throw new Error(`Unsupported parser version for ${sourceFile} at byte ${checkpoint.offset}`);
  }
  if (typeof lineNumber !== "number" || !Number.isSafeInteger(lineNumber)
    || lineNumber < (checkpoint.offset ? 1 : 0) || lineNumber > checkpoint.offset) {
    throw new Error(invalid);
  }
  try {
    return { version, lineNumber, decoder: stateRecord(saved.decoder), replay: readReplayPlan(saved, checkpoint, format.gapVersion) };
  } catch {
    throw new Error(invalid);
  }
}
