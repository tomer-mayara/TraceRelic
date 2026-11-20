import type { ReadPosition, TranscriptSource } from "../history/index.ts";
import type { Checkpoint } from "../storage/collector-storage.ts";
import type { ChatParser } from "./decoded-chat.ts";

const parserVersion = 1;

export class TranscriptCursor<Entry> {
  private constructor(readonly position: ReadPosition, readonly parser: ChatParser<Entry>) {}

  static async restore<Entry>(
    source: TranscriptSource<Entry>, checkpoint: Checkpoint | null, resume: (state?: unknown) => ChatParser<Entry>,
  ): Promise<TranscriptCursor<Entry>> {
    let position = { offset: 0, lineNumber: 0 };
    if (!checkpoint) return new TranscriptCursor(position, resume());
    const { offset, parserState } = checkpoint;
    const invalid = `Cannot restore parser state for ${source.sourceFile} at byte ${offset}`;
    let saved: unknown;
    try {
      saved = JSON.parse(parserState || "{}");
    } catch {
      throw new Error(invalid);
    }
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error(invalid);
    if (Object.keys(saved).length === 0) {
      // Earlier collectors stored "{}". Rebuild context through the accepted newline without writing those records again.
      const parser = resume();
      for await (const batch of source.readBatches(position, undefined, offset)) {
        parser.decodeBatch(batch.entries);
        position = batch.next;
      }
      if (position.offset !== offset) throw new Error(invalid);
      return new TranscriptCursor(position, parser);
    }
    if (!("version" in saved) || saved.version !== parserVersion) {
      throw new Error(`Unsupported parser version for ${source.sourceFile} at byte ${offset}`);
    }
    if (!("lineNumber" in saved) || typeof saved.lineNumber !== "number" || !Number.isSafeInteger(saved.lineNumber)
      || saved.lineNumber < 1 || saved.lineNumber > offset || !("decoder" in saved)
      || !saved.decoder || typeof saved.decoder !== "object" || Array.isArray(saved.decoder)) throw new Error(invalid);
    try {
      return new TranscriptCursor({ offset, lineNumber: saved.lineNumber }, resume(saved.decoder));
    } catch {
      throw new Error(invalid);
    }
  }

  checkpointAt({ offset, lineNumber }: ReadPosition): Checkpoint {
    return { offset, parserState: JSON.stringify({ version: parserVersion, lineNumber, decoder: this.parser.snapshot() }) };
  }
}
