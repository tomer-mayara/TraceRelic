import type { LocalHistoryEntry } from "../history/history-provider.ts";
import { isHistoryTimestamp } from "@tracerelic/shared";
import { JsonlRecords } from "./jsonl-records.ts";
import type {
  BatchRecords, ReadPosition, RecordBatch, SelectedFile, Transcript, TranscriptEntry, TranscriptSource,
} from "./transcript-source.ts";

const beginning: ReadPosition = { offset: 0, lineNumber: 0 };
const defaultBatchBytes = 256 * 1024;
const newline = Buffer.from([0x0a]);

/** Reads a selected captured file in byte-bounded batches with prefix digests. */
export class TranscriptBatches {
  constructor(private readonly jsonl: JsonlRecords) {}

  transcriptSource<H extends LocalHistoryEntry["harness"]>(source: SelectedFile<H>): TranscriptSource<TranscriptEntry<H>> {
    const { file, sessionId } = source;
    return {
      sessionId, sourceFile: file.sourceFile, fileSize: file.fileSize,
      completeEnd: () => file.completeEnd(),
      prefixDigests: offsets => file.prefixDigests(offsets),
      readBatches: (position, maxBatchBytes = defaultBatchBytes, endOffset = file.fileSize) =>
        this.readBatches(source, position, maxBatchBytes, endOffset),
    };
  }

  async snapshot<H extends LocalHistoryEntry["harness"]>(
    source: TranscriptSource<TranscriptEntry<H>>,
  ): Promise<Transcript<TranscriptEntry<H>> | undefined> {
    const entries: TranscriptEntry<H>[] = [];
    for await (const batch of source.readBatches(beginning)) {
      for (const { startOffset: _startOffset, afterBlankPrefix: _afterBlankPrefix, recordPrefixDigest: _digest, ...entry } of batch.entries) entries.push(entry);
    }
    const last = entries.at(-1);
    if (last) return { sessionId: source.sessionId, sourceFile: source.sourceFile, entries, endOffset: last.endOffset };
  }

  private async *readBatches<H extends LocalHistoryEntry["harness"]>(
    source: SelectedFile<H>, position: ReadPosition, maxBatchBytes: number, endOffset: number,
  ): AsyncGenerator<RecordBatch<TranscriptEntry<H>>> {
    if (!Number.isSafeInteger(maxBatchBytes) || maxBatchBytes <= 0) throw new RangeError("Expected a positive batch byte limit");
    if (![position.offset, position.lineNumber, endOffset].every(n => Number.isSafeInteger(n) && n >= 0)) {
      throw new RangeError("Expected nonnegative byte and line positions");
    }
    const { file } = source;
    let cursor = position;
    while (cursor.offset < Math.min(file.fileSize, endOffset)) {
      const revision = file.statRevision;
      let reopen = false;
      for await (const batch of this.readCapture(source, cursor, maxBatchBytes, endOffset)) {
        cursor = batch.next;
        yield batch;
        if (file.statRevision !== revision) {
          // Discard prefetched bytes after a verified append and resume from the verified batch hash.
          reopen = true;
          break;
        }
      }
      if (!reopen) return;
    }
    await file.verifyPath();
  }

  private async *readCapture<H extends LocalHistoryEntry["harness"]>(
    source: SelectedFile<H>, position: ReadPosition, maxBatchBytes: number, endOffset: number,
  ): AsyncGenerator<RecordBatch<TranscriptEntry<H>>> {
    const { file, harness, sessionId } = source;
    const { hash, revision } = await file.startBatch(position.offset);
    let records: BatchRecords<TranscriptEntry<H>> = { entries: [] };
    let next = position;
    let batchStart = position.offset;
    for await (const line of this.jsonl.completeLines(file.chunks(position.offset, endOffset))) {
      const startOffset = next.offset;
      const offset = startOffset + line.length + 1;
      if (next.offset > batchStart && offset - batchStart > maxBatchBytes) {
        yield { ...records, next, prefixDigest: await file.finishBatch(next.offset, hash, revision) };
        records = { entries: [] };
        batchStart = next.offset;
      }
      const lineNumber = next.lineNumber + 1;
      next = { offset, lineNumber };
      hash.update(line).update(newline);
      const record = this.jsonl.decode(line);
      if (record && source.matches(record, lineNumber)) {
        const { timestamp } = record;
        records.entries.push({ harness, sessionId, sourceFile: file.sourceFile, record, lineNumber, startOffset, endOffset: offset,
          ...(source.isConversation(record) && { recordPrefixDigest: hash.copy().digest("hex") }),
          ...(offset === source.blankPrefixHeaderEnd && { afterBlankPrefix: true }),
          ...(isHistoryTimestamp(timestamp) ? { timestamp } : {}) });
      } else if (!record && !JsonlRecords.isBlankLine(line)) {
        (records.damagedLines ??= []).push({ lineNumber, startOffset, endOffset: offset });
      }
      if (offset - batchStart >= maxBatchBytes) {
        yield { ...records, next, prefixDigest: await file.finishBatch(next.offset, hash, revision) };
        records = { entries: [] };
        batchStart = offset;
      }
    }
    if (next.offset > batchStart) yield { ...records, next, prefixDigest: await file.finishBatch(next.offset, hash, revision) };
    else await file.verifyPath();
  }
}
