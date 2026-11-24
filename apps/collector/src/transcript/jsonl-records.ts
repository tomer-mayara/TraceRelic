import type { LocalHistoryEntry } from "../history/history-provider.ts";
import { CapturedTranscriptFile } from "./captured-transcript-file.ts";
import { JsonRecord } from "./json-record.ts";
import type { DecodedRecord } from "./transcript-source.ts";

/** Splits JSONL bytes into complete lines and decodes each line as one UTF-8 JSON object. */
export class JsonlRecords {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  static isBlankLine(line: Buffer): boolean {
    // The terminating LF is already removed. A JSON line can also contain space, tab or CR.
    return line.every(byte => byte === 0x20 || byte === 0x09 || byte === 0x0d);
  }

  inspectFile<T>(sourceFile: string, inspect: (records: AsyncIterable<DecodedRecord>) => Promise<T>, include?: (line: Buffer) => boolean) {
    return CapturedTranscriptFile.inspect(sourceFile, chunks => inspect(this.decodeRecords(chunks, include)));
  }

  readRecords(sourceFile: string): AsyncIterable<DecodedRecord> {
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
      if (onlyBlanks) onlyBlanks = !record && JsonlRecords.isBlankLine(line);
    }
  }

  decode(line: Buffer): LocalHistoryEntry["record"] | undefined {
    try {
      const record: unknown = JSON.parse(this.decoder.decode(line));
      if (JsonRecord.is(record)) return record;
    } catch {
      // Batches report the physical range of an unreadable record.
    }
  }

  async *completeLines(chunks: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
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
