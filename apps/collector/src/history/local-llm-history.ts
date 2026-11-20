import { matchesRecordedPath, recordedPathDialect, type harnesses } from "@tracerelic/shared";
import { compareRecordedInstants, isHistoryTimestamp, recordedInstant } from "../recorded-timestamp.ts";
import { CapturedTranscriptFile, TranscriptChangedError } from "./captured-transcript-file.ts";

export interface ScanSelection {
  readonly sessionIds?: readonly string[];
  readonly projectPaths?: readonly string[];
}

export interface SourceDiscoveryOptions {
  sourceFile?: string;
  onChanged?: (error: TranscriptChangedError) => void;
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
  readonly recordPrefixDigest?: string;
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

export interface ClaudeSubagent {
  readonly parentSessionId: string;
  readonly agentId: string;
}

interface TranscriptSourceInfo {
  readonly sessionId: string;
  readonly sourceFile: string;
  readonly fileSize: number;
  readonly previousCopy: boolean;
  readonly codexForkHeader?: { readonly parentSessionId: string; readonly forkedAt?: string };
  readonly codexHeaderEnd?: number;
  readonly claudeSubagent?: ClaudeSubagent;
  readonly selectionCwd?: string;
  readonly projectDir?: string;
  readonly currentFileCwd?: string;
  readonly currentFilePath?: string;
}

export interface TranscriptSource<Entry> extends TranscriptSourceInfo {
  completeEnd(): Promise<number>;
  prefixDigests(offsets: readonly number[]): Promise<readonly VerifiedPrefix[]>;
  readBatches(position: ReadPosition, maxBatchBytes?: number, endOffset?: number): AsyncIterable<RecordBatch<Entry>>;
}

interface DecodedRecord extends Pick<LocalHistoryEntry, "lineNumber" | "record"> {
  readonly endOffset: number;
  readonly afterBlankPrefix?: true;
}

interface SelectedFile<H extends LocalHistoryEntry["harness"]> extends Pick<TranscriptSourceInfo, "sessionId" | "previousCopy" | "selectionCwd" | "projectDir"> {
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

  protected abstract readWindow(inRange: (timestamp: string) => boolean): Promise<readonly LocalHistoryEntry[]>;

  async readLocalHistory(fromDate: Date, toDate: Date): Promise<readonly LocalHistoryEntry[]> {
    if (!Number.isFinite(fromDate.getTime()) || !Number.isFinite(toDate.getTime()) || fromDate > toDate) {
      throw new RangeError("Expected valid dates with fromDate at or before toDate");
    }
    const instant = (date: Date) => ({ second: Math.floor(date.getTime() / 1000),
      fraction: "0" + String(date.getUTCMilliseconds()).padStart(3, "0").replace(/0+$/, "") });
    return this.readWindow(this.window(instant(fromDate), instant(toDate)));
  }

  async readLocalHistoryInstants(from: string, to: string): Promise<readonly LocalHistoryEntry[]> {
    const start = isHistoryTimestamp(from) && recordedInstant(from);
    const end = isHistoryTimestamp(to) && recordedInstant(to);
    if (!start || !end || compareRecordedInstants(start, end) > 0) throw new RangeError("Expected valid instants with from at or before to");
    return this.readWindow(this.window(start, end));
  }

  private window(start: { second: number; fraction: string }, end: typeof start) {
    return (timestamp: string) => {
      const at = isHistoryTimestamp(timestamp) && recordedInstant(timestamp);
      return !!at && compareRecordedInstants(start, at) <= 0 && compareRecordedInstants(at, end) < 0;
    };
  }

  protected async *discoverFileSafely<T>(file: AsyncIterable<T>, options: SourceDiscoveryOptions): AsyncGenerator<T> {
    try {
      yield* file;
    } catch (error) {
      if (!(error instanceof TranscriptChangedError) || !options.onChanged) throw error;
      options.onChanged(error);
    }
  }

  protected selected({ sessionIds = [], projectPaths = [] }: ScanSelection, sessionId: string, cwd: unknown): boolean {
    if (!sessionIds.length && !projectPaths.length) return true;
    if (sessionIds.includes(sessionId)) return true;
    return projectPaths.some(root => matchesRecordedPath(root, cwd));
  }

  protected isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  protected hasRecordedTimestamp(value: unknown): value is string {
    return isHistoryTimestamp(value);
  }

  protected workingDirectory(value: unknown): string | undefined {
    if (typeof value === "string" && recordedPathDialect(value)) return value;
  }

  protected transcriptSource<H extends LocalHistoryEntry["harness"]>(source: SelectedFile<H>): TranscriptSource<TranscriptEntry<H>> {
    const { file, sessionId, previousCopy, selectionCwd, projectDir } = source;
    return {
      sessionId, previousCopy, sourceFile: file.sourceFile, fileSize: file.fileSize,
      ...(selectionCwd && { selectionCwd }), ...(projectDir && { projectDir }),
      completeEnd: () => file.completeEnd(),
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
    for await (const line of this.completeLines(file.chunks(position.offset, endOffset))) {
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
      const record = this.decode(line);
      if (record && source.matches(record, lineNumber)) {
        const { timestamp } = record;
        records.entries.push({ harness, sessionId, sourceFile: file.sourceFile, record, lineNumber, startOffset, endOffset: offset,
          ...((record.type === "response_item" || record.type === "event_msg" || record.type === "user" || record.type === "assistant")
            && { recordPrefixDigest: hash.copy().digest("hex") }),
          ...(offset === source.blankPrefixHeaderEnd && { afterBlankPrefix: true }),
          ...(this.hasRecordedTimestamp(timestamp) ? { timestamp } : {}) });
      } else if (!record && !isBlankLine(line)) {
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

  protected inspectFile<T>(sourceFile: string, inspect: (records: AsyncIterable<DecodedRecord>) => Promise<T>, include?: (line: Buffer) => boolean) {
    return CapturedTranscriptFile.inspect(sourceFile, chunks => inspect(this.decodeRecords(chunks, include)));
  }

  protected readRecords(sourceFile: string): AsyncIterable<DecodedRecord> {
    return this.decodeRecords(CapturedTranscriptFile.read(sourceFile));
  }

  private async *decodeRecords(chunks: AsyncIterable<Buffer>, include?: (line: Buffer) => boolean): AsyncGenerator<DecodedRecord> {
    let lineNumber = 0;
    let offset = 0;
    let onlyBlanks = true;
    for await (const line of this.completeLines(chunks)) {
      lineNumber++;
      offset += line.length + 1;
      const record = !include || include(line) ? this.decode(line) : undefined;
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
