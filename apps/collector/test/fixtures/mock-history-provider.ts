import type { HistoryProvider, HistoryWindow, LocalHistoryEntry } from "@tracerelic/collector/history";

type Harness = LocalHistoryEntry["harness"];

/** A history provider that records each window that it receives. It returns the specified entries or the specified error. */
export class MockHistoryProvider implements HistoryProvider {
  readonly windows: HistoryWindow[] = [];

  constructor(
    readonly harness: Harness,
    private readonly result: readonly LocalHistoryEntry[] | Error = [],
    private readonly release?: Promise<void>,
  ) {}

  static entry(harness: Harness, sessionId: string, timestamp: string): LocalHistoryEntry {
    return { harness, sessionId, sourceFile: `/${harness}/${sessionId}.jsonl`, lineNumber: 1, timestamp, record: { sessionId, timestamp } };
  }

  async readHistory(window: HistoryWindow): Promise<readonly LocalHistoryEntry[]> {
    this.windows.push(window);
    await this.release;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}
