import { compareRecordedInstants, isHistoryTimestamp, recordedInstant } from "@tracerelic/shared";

interface WindowInstant {
  readonly second: number;
  readonly fraction: string;
}

/** The half-open interval from an inclusive start to an exclusive end. */
export class HistoryWindow {
  private constructor(private readonly start: WindowInstant, private readonly end: WindowInstant) {}

  static between(fromDate: Date, toDate: Date): HistoryWindow {
    if (!Number.isFinite(fromDate.getTime()) || !Number.isFinite(toDate.getTime()) || fromDate > toDate) {
      throw new RangeError("Expected valid dates with fromDate at or before toDate");
    }
    const instant = (date: Date) => ({ second: Math.floor(date.getTime() / 1000),
      fraction: "0" + String(date.getUTCMilliseconds()).padStart(3, "0").replace(/0+$/, "") });
    return new HistoryWindow(instant(fromDate), instant(toDate));
  }

  static betweenInstants(from: string, to: string): HistoryWindow {
    const start = isHistoryTimestamp(from) && recordedInstant(from);
    const end = isHistoryTimestamp(to) && recordedInstant(to);
    if (!start || !end || compareRecordedInstants(start, end) > 0) throw new RangeError("Expected valid instants with from at or before to");
    return new HistoryWindow(start, end);
  }

  contains(timestamp: string): boolean {
    const at = isHistoryTimestamp(timestamp) && recordedInstant(timestamp);
    return !!at && compareRecordedInstants(this.start, at) <= 0 && compareRecordedInstants(at, this.end) < 0;
  }
}
