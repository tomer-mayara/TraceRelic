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
}
