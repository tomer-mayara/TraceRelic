import type { ReadPosition, TranscriptSource, VerifiedPrefix } from "../history/index.ts";
import type { Checkpoint, Message } from "../storage/collector-storage.ts";
import { stateRecord } from "./chat-parser-state.ts";
import type { ChatParser, DecodedChat, DecodedUsage } from "./decoded-chat.ts";
import {
  countReplayMessages, planReplayOccurrences, readReplayOccurrences, reconcileReplayMessages, type ReplayOccurrences,
} from "./transcript-replay.ts";

export interface ParserFormat<Entry> {
  version: number;
  resume(state?: unknown): ChatParser<Entry>;
  upgrade?(oldDecoder?: object): { parser: ChatParser<Entry>; read(entries: readonly Entry[]): Partial<DecodedUsage> };
}

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
  readonly usageDiagnostics: NonNullable<DecodedUsage["usageDiagnostics"]> = [];
  hasGap = false;

  add(batch: Partial<DecodedUsage>): void {
    for (const record of batch.usage ?? []) this.usage.push(record);
    for (const anchor of batch.usageAnchors ?? []) this.usageAnchors.push(anchor);
    for (const window of batch.usageWindows ?? []) this.usageWindows.push(window);
    for (const report of batch.claudeUsageReports ?? []) this.claudeUsageReports.push(report);
    for (const diagnostic of batch.usageDiagnostics ?? []) this.usageDiagnostics.push(diagnostic);
    this.hasGap ||= batch.hasGap === true;
  }
}

export class TranscriptCursor<Entry> {
  private constructor(
    private readonly position: ReadPosition, private readonly format: ParserFormat<Entry>,
    private readonly parser: ChatParser<Entry>, private readonly replay?: ReplayPlan,
    private readonly backfill?: { usage: BackfilledUsage; checkpoint: Checkpoint },
  ) {}

  static async restore<Entry>(
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
      if (saved && (saved.version === format.version || saved.version === replayVersion)) {
        return new TranscriptCursor({ offset: checkpoint.offset, lineNumber: saved.lineNumber },
          format, format.resume(saved.decoder), saved.replay);
      }
      upgrade = format.upgrade?.(saved?.decoder);
      parser = upgrade?.parser ?? format.resume();
    } catch {
      throw new Error(invalid);
    }
    const backfill = upgrade ? new BackfilledUsage() : undefined;
    for await (const batch of source.readBatches(position, undefined, checkpoint.offset)) {
      if (upgrade && backfill) backfill.add(upgrade.read(batch.entries));
      else parser.decodeBatch(batch.entries);
      position = batch.next;
    }
    if (position.offset !== checkpoint.offset || (saved && position.lineNumber !== saved.lineNumber)) throw new Error(invalid);
    return new TranscriptCursor(position, format, parser, undefined, backfill && { usage: backfill, checkpoint });
  }

  private static async rebuild<Entry>(source: TranscriptSource<Entry>, format: ParserFormat<Entry>, accepted: readonly Message[]) {
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
    for await (const { entries, next, prefixDigest } of source.readBatches(this.position)) {
      if (prepare && next.offset < source.fileSize) {
        await prepare(entries, source.readBatches(next), this.position.lineNumber);
        prepare = undefined;
      }
      const chat = this.parser.decodeBatch(entries);
      if (this.replay?.occurrences) reconcileReplayMessages(chat, this.replay.occurrences);
      yield { chat, next, prefixDigest };
    }
  }

  async *read(source: TranscriptSource<Entry>) {
    let backfill = this.backfill?.usage;
    for await (const { chat, next, prefixDigest } of this.decode(source)) {
      if (backfill) {
        backfill.add(chat);
        Object.assign(chat, backfill);
        backfill = undefined;
      }
      yield { chat, checkpoint: this.checkpointAt(next, prefixDigest), upgrade: false };
    }
    if (backfill) {
      const chat: DecodedChat = { messages: [], metadata: {}, ...backfill };
      yield { chat, checkpoint: this.checkpointAt(this.position, this.backfill?.checkpoint.prefixDigest), upgrade: true };
    }
  }

  private checkpointAt({ offset, lineNumber }: ReadPosition, prefixDigest?: string): Checkpoint {
    const through = this.replay?.through;
    const replayThrough = through && offset < through.offset ? through : undefined;
    const replayOccurrences = this.replay?.occurrences ?? (replayThrough ? {} : undefined);
    const version = replayOccurrences ? replayVersion : this.format.version;
    const parserState = JSON.stringify({ version, lineNumber, decoder: this.parser.snapshot(), replayOccurrences });
    return { offset, parserState, prefixDigest, ...(replayThrough && { replayThrough }) };
  }
}

function readReplayPlan(state: Record<string, unknown>, checkpoint: Checkpoint): ReplayPlan | undefined {
  const occurrences = readReplayOccurrences(state.replayOccurrences);
  if ((state.version === replayVersion) !== !!occurrences || (checkpoint.replayThrough && !occurrences)) {
    throw new Error("Invalid replay state");
  }
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
  if (version !== format.version && version !== replayVersion && !(format.upgrade && version === 1)) {
    throw new Error(`Unsupported parser version for ${sourceFile} at byte ${checkpoint.offset}`);
  }
  if (typeof lineNumber !== "number" || !Number.isSafeInteger(lineNumber)
    || lineNumber < (checkpoint.offset ? 1 : 0) || lineNumber > checkpoint.offset) {
    throw new Error(invalid);
  }
  try {
    return { version, lineNumber, decoder: stateRecord(saved.decoder), replay: readReplayPlan(saved, checkpoint) };
  } catch {
    throw new Error(invalid);
  }
}
