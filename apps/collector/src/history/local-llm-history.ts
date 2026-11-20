import { createReadStream, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { harnesses } from "@tracerelic/shared";
import { isRecordedTimestamp } from "../recorded-timestamp.ts";
import { CapturedTranscriptFile } from "./captured-transcript-file.ts";

export interface ScanSelection {
  readonly sessionIds?: readonly string[];
  readonly projectPaths?: readonly string[];
}

export interface LocalHistoryEntry {
  readonly harness: (typeof harnesses)[number];
  readonly sessionId: string;
  readonly sourceFile: string;
  readonly lineNumber: number;
  readonly timestamp: string;
  readonly record: Readonly<Record<string, unknown>>;
}

export interface TranscriptEntry<Harness extends LocalHistoryEntry["harness"]> extends Omit<LocalHistoryEntry, "timestamp" | "harness"> {
  readonly harness: Harness;
  readonly timestamp?: string;
  readonly endOffset: number;
}

export interface Transcript<Entry> {
  readonly sessionId: string;
  readonly sourceFile: string;
  readonly endOffset: number;
  readonly entries: readonly Entry[];
}

export interface ReadPosition {
  readonly offset: number;
  readonly lineNumber: number;
}

export interface DamagedLine {
  readonly lineNumber: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

interface BatchRecords<Entry> {
  entries: (Entry & { readonly startOffset: number; readonly afterBlankPrefix?: true })[];
  damagedLines?: DamagedLine[];
}

export interface RecordBatch<Entry> extends Readonly<BatchRecords<Entry>> {
  readonly next: ReadPosition;
  readonly prefixDigest: string;
}

export interface VerifiedPrefix {
  readonly offset: number;
  readonly prefixDigest: string;
}

interface TranscriptSourceInfo {
  readonly sessionId: string;
  readonly sourceFile: string;
  readonly fileSize: number;
  readonly previousCopy: boolean;
}

export interface TranscriptSource<Entry> extends TranscriptSourceInfo {
  prefixDigests(offsets: readonly number[]): Promise<readonly VerifiedPrefix[]>;
  readBatches(position: ReadPosition, maxBatchBytes?: number, endOffset?: number): AsyncIterable<RecordBatch<Entry>>;
}

interface DecodedRecord extends Pick<LocalHistoryEntry, "lineNumber" | "record"> {
  readonly endOffset: number;
  readonly afterBlankPrefix?: true;
}

interface SelectedFile<H extends LocalHistoryEntry["harness"]> extends Pick<TranscriptSourceInfo, "sessionId" | "previousCopy"> {
  readonly file: CapturedTranscriptFile;
  readonly harness: H;
  readonly blankPrefixHeaderEnd?: number;
  matches(record: LocalHistoryEntry["record"], lineNumber: number): boolean;
}
const beginning: ReadPosition = { offset: 0, lineNumber: 0 };
const defaultBatchBytes = 256 * 1024;
const newline = Buffer.from([0x0a]);

function isBlankLine(line: Buffer): boolean {
  // The terminating LF is already removed. A JSON line can also contain space, tab or CR.
  return line.every(byte => byte === 0x20 || byte === 0x09 || byte === 0x0d);
}

export abstract class LocalLLMHistory {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  abstract readLocalHistory(fromDate: Date, toDate: Date): Promise<readonly LocalHistoryEntry[]>;

  protected selected({ sessionIds = [], projectPaths = [] }: ScanSelection, sessionId: string, cwd: unknown): boolean {
    if (!sessionIds.length && !projectPaths.length) return true;
    if (sessionIds.includes(sessionId)) return true;
    if (typeof cwd !== "string" || !cwd.length) return false;
    return projectPaths.some(root => {
      if (!root.length) return false;
      const path = relative(root, cwd);
      return !isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep);
    });
  }

  protected isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  protected hasRecordedTimestamp(value: unknown): value is string {
    return typeof value === "string"
      && /^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/i.test(value)
      && isRecordedTimestamp(value);
  }

  protected dateFilter(fromDate: Date, toDate: Date): (timestamp: string) => boolean {
    const from = fromDate.getTime();
    const to = toDate.getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      throw new RangeError("Expected valid dates with fromDate at or before toDate");
    }
    return timestamp => {
      // A Date window has millisecond endpoints. A leap second still belongs before the next minute.
      const instant = Date.parse(timestamp.replace(/:60(?:\.\d+)?(?=Z|[+-])/i, ":59.999"));
      return from <= instant && instant < to && this.hasRecordedTimestamp(timestamp);
    };
  }

  protected async listDirectoryIfPresent(path: string, recursive = false): Promise<Dirent[]> {
    try {
      return await readdir(path, { recursive, withFileTypes: true });
    } catch (error) {
      if (this.isRecord(error) && error.code === "ENOENT" && error.path === path) return [];
      throw error;
    }
  }

  protected transcriptSource<H extends LocalHistoryEntry["harness"]>(source: SelectedFile<H>): TranscriptSource<TranscriptEntry<H>> {
    const { file, sessionId, previousCopy } = source;
    return {
      sessionId, previousCopy, sourceFile: file.sourceFile, fileSize: file.fileSize,
      prefixDigests: offsets => file.prefixDigests(offsets),
      readBatches: (position, maxBatchBytes = defaultBatchBytes, endOffset = file.fileSize) =>
        this.readBatches(source, position, maxBatchBytes, endOffset),
    };
  }

  protected async snapshot<H extends LocalHistoryEntry["harness"]>(
    source: TranscriptSource<TranscriptEntry<H>>,
  ): Promise<Transcript<TranscriptEntry<H>> | undefined> {
    const entries: TranscriptEntry<H>[] = [];
    for await (const batch of source.readBatches(beginning)) {
      for (const { startOffset: _startOffset, afterBlankPrefix: _afterBlankPrefix, ...entry } of batch.entries) entries.push(entry);
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
    const { file, harness, sessionId } = source;
    if (position.offset >= Math.min(file.fileSize, endOffset)) {
      await file.verifyPath();
      return;
    }
    const hash = await file.startBatch(position.offset);
    let records: BatchRecords<TranscriptEntry<H>> = { entries: [] };
    let next = position;
    let batchStart = position.offset;
    for await (const line of this.completeLines(file.chunks(position.offset, endOffset))) {
      const startOffset = next.offset;
      const offset = startOffset + line.length + 1;
      if (next.offset > batchStart && offset - batchStart > maxBatchBytes) {
        await file.verifyPath();
        yield { ...records, next, prefixDigest: file.finishBatch(next.offset, hash) };
        records = { entries: [] };
        batchStart = next.offset;
      }
      const lineNumber = next.lineNumber + 1;
      next = { offset, lineNumber };
      hash.update(line).update(newline);
      const record = this.decode(line);
      if (record && source.matches(record, lineNumber)) {
        const { timestamp } = record;
        records.entries.push({ harness, sessionId, sourceFile: file.sourceFile, record, lineNumber, startOffset, endOffset: offset,
          ...(offset === source.blankPrefixHeaderEnd && { afterBlankPrefix: true }),
          ...(this.hasRecordedTimestamp(timestamp) ? { timestamp } : {}) });
      } else if (!record && !isBlankLine(line)) {
        (records.damagedLines ??= []).push({ lineNumber, startOffset, endOffset: offset });
      }
      if (offset - batchStart >= maxBatchBytes) {
        await file.verifyPath();
        yield { ...records, next, prefixDigest: file.finishBatch(next.offset, hash) };
        records = { entries: [] };
        batchStart = offset;
      }
    }
    await file.verifyPath();
    if (next.offset > batchStart) yield { ...records, next, prefixDigest: file.finishBatch(next.offset, hash) };
  }

  protected inspectFile<T>(sourceFile: string, inspect: (records: AsyncIterable<DecodedRecord>) => Promise<T>) {
    return CapturedTranscriptFile.inspect(sourceFile, chunks => inspect(this.decodeRecords(chunks)));
  }

  protected readRecords(sourceFile: string): AsyncIterable<DecodedRecord> {
    return this.decodeRecords(createReadStream(sourceFile));
  }

  private async *decodeRecords(chunks: AsyncIterable<Buffer>): AsyncGenerator<DecodedRecord> {
    let lineNumber = 0;
    let offset = 0;
    let onlyBlanks = true;
    for await (const line of this.completeLines(chunks)) {
      lineNumber++;
      offset += line.length + 1;
      const record = this.decode(line);
      if (record) yield { lineNumber, endOffset: offset, record, ...(onlyBlanks && lineNumber > 1 && { afterBlankPrefix: true }) };
      if (onlyBlanks) onlyBlanks = !record && isBlankLine(line);
    }
  }

  private decode(line: Buffer): LocalHistoryEntry["record"] | undefined {
    try {
      const record: unknown = JSON.parse(this.decoder.decode(line));
      if (this.isRecord(record)) return record;
    } catch {
      // Batches report the physical range of an unreadable record.
    }
  }

  private async *completeLines(chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    const fragments: Buffer[] = [];
    for await (const chunk of chunks) {
      let start = 0;
      for (let end = chunk.indexOf(0x0a); end >= 0; end = chunk.indexOf(0x0a, start)) {
        const part = chunk.subarray(start, end);
        const line = fragments.length ? Buffer.concat([...fragments, part]) : part;
        fragments.length = 0;
        yield line;
        start = end + 1;
      }
      if (start < chunk.length) fragments.push(chunk.subarray(start));
    }
    // The writer may still be appending the unterminated final record.
  }
}
