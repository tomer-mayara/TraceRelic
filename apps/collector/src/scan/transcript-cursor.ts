import type { ReadPosition, TranscriptSource } from "../history/index.ts";
import type { Checkpoint } from "../storage/collector-storage.ts";
import type { ChatParser, DecodedChat, DecodedUsage } from "./decoded-chat.ts";

export interface ParserFormat<Entry> {
  version: number;
  resume(state?: unknown): ChatParser<Entry>;
  upgrade?(oldDecoder?: object): { parser: ChatParser<Entry>; read(entries: readonly Entry[]): DecodedUsage };
}

class BackfilledUsage implements DecodedUsage {
  readonly usage: DecodedUsage["usage"] = [];
  readonly usageAnchors: NonNullable<DecodedUsage["usageAnchors"]> = [];
  readonly usageWindows: DecodedUsage["usageWindows"] = [];
  hasGap = false;

  add(batch: Partial<DecodedUsage>): void {
    for (const record of batch.usage ?? []) this.usage.push(record);
    for (const anchor of batch.usageAnchors ?? []) this.usageAnchors.push(anchor);
    for (const window of batch.usageWindows ?? []) this.usageWindows.push(window);
    this.hasGap ||= batch.hasGap === true;
  }
}

export class TranscriptCursor<Entry> {
  private constructor(
    private readonly position: ReadPosition, private readonly format: ParserFormat<Entry>,
    private readonly parser: ChatParser<Entry>, private readonly backfill?: BackfilledUsage,
  ) {}

  static async restore<Entry>(
    source: TranscriptSource<Entry>, checkpoint: Checkpoint | null, format: ParserFormat<Entry>,
  ): Promise<TranscriptCursor<Entry>> {
    let position = { offset: 0, lineNumber: 0 };
    if (!checkpoint) return new TranscriptCursor(position, format, format.resume());
    const invalid = `Cannot restore parser state for ${source.sourceFile} at byte ${checkpoint.offset}`;
    const saved = readState(checkpoint, invalid);
    if (saved && saved.version !== format.version && !(format.upgrade && saved.version === 1)) {
      throw new Error(`Unsupported parser version for ${source.sourceFile} at byte ${checkpoint.offset}`);
    }
    let upgrade: ReturnType<NonNullable<ParserFormat<Entry>["upgrade"]>> | undefined;
    let parser: ChatParser<Entry>;
    try {
      if (saved && saved.version === format.version) {
        return new TranscriptCursor({ offset: checkpoint.offset, lineNumber: saved.lineNumber }, format, format.resume(saved.decoder));
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
    return new TranscriptCursor(position, format, parser, backfill);
  }

  async *read(source: TranscriptSource<Entry>) {
    let backfill = this.backfill;
    let prepare = this.parser.prepareLookahead?.bind(this.parser);
    if (this.position.offset < source.fileSize) {
      for await (const { entries, next } of source.readBatches(this.position)) {
        if (prepare && next.offset < source.fileSize) {
          await prepare(entries, source.readBatches(next), this.position.lineNumber);
          prepare = undefined;
        }
        const chat = this.parser.decodeBatch(entries);
        if (backfill) {
          backfill.add(chat);
          Object.assign(chat, backfill);
          backfill = undefined;
        }
        yield { chat, checkpoint: this.checkpointAt(next), upgrade: false };
      }
    }
    if (backfill) {
      const chat: DecodedChat = { messages: [], metadata: {}, ...backfill };
      yield { chat, checkpoint: this.checkpointAt(this.position), upgrade: true };
    }
  }

  private checkpointAt({ offset, lineNumber }: ReadPosition): Checkpoint {
    const parserState = JSON.stringify({ version: this.format.version, lineNumber, decoder: this.parser.snapshot() });
    return { offset, parserState };
  }
}

function readState(checkpoint: Checkpoint, invalid: string) {
  let saved: unknown;
  try {
    saved = JSON.parse(checkpoint.parserState || "{}");
  } catch {
    throw new Error(invalid);
  }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error(invalid);
  if (Object.keys(saved).length === 0) return;
  if (!("version" in saved) || !("lineNumber" in saved) || typeof saved.lineNumber !== "number"
    || !Number.isSafeInteger(saved.lineNumber) || saved.lineNumber < 1 || saved.lineNumber > checkpoint.offset
    || !("decoder" in saved) || !saved.decoder || typeof saved.decoder !== "object" || Array.isArray(saved.decoder)) {
    throw new Error(invalid);
  }
  return { version: saved.version, lineNumber: saved.lineNumber, decoder: saved.decoder };
}
