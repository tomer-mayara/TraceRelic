import { createReadStream, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import type { harnesses } from "@tracerelic/shared";
import { isRecordedTimestamp } from "../recorded-timestamp.ts";

export interface LocalHistoryEntry {
  readonly harness: (typeof harnesses)[number];
  readonly sessionId: string;
  readonly sourceFile: string;
  readonly lineNumber: number;
  readonly timestamp: string;
  readonly record: Readonly<Record<string, unknown>>;
}

export abstract class LocalLLMHistory {
  abstract readLocalHistory(fromDate: Date, toDate: Date): Promise<readonly LocalHistoryEntry[]>;

  protected isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
      return from <= instant && instant < to
        && /^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$/i.test(timestamp)
        && isRecordedTimestamp(timestamp);
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

  protected async *readRecords(sourceFile: string): AsyncGenerator<Pick<LocalHistoryEntry, "lineNumber" | "record">> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let lineNumber = 0;
    for await (const line of this.completeLines(sourceFile)) {
      lineNumber++;
      let record: unknown;
      try {
        record = JSON.parse(decoder.decode(line));
      } catch {
        continue;
      }
      if (this.isRecord(record)) yield { lineNumber, record };
    }
  }

  private async *completeLines(sourceFile: string): AsyncGenerator<Buffer> {
    const fragments: Buffer[] = [];
    const chunks: AsyncIterable<Buffer> = createReadStream(sourceFile);
    for await (const chunk of chunks) {
      let start = 0;
      for (let end = chunk.indexOf(0x0a); end >= 0; end = chunk.indexOf(0x0a, start)) {
        const part = chunk.subarray(start, end);
        yield fragments.length ? Buffer.concat([...fragments, part]) : part;
        fragments.length = 0;
        start = end + 1;
      }
      if (start < chunk.length) fragments.push(chunk.subarray(start));
    }
    // The writer may still be appending the unterminated final record.
  }
}
