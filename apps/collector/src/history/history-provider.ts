import type { harnesses } from "@tracerelic/shared";
import type { HistoryWindow } from "./history-window.ts";

export interface LocalHistoryEntry {
  readonly harness: (typeof harnesses)[number];
  readonly sessionId: string;
  readonly sourceFile: string;
  readonly lineNumber: number;
  readonly timestamp: string;
  readonly record: Readonly<Record<string, unknown>>;
}

/** The local transcripts of one provider. The provider receives its root directory. */
export interface HistoryProvider {
  /** Read each source anew, in file order. Return the records whose timestamp is in the window. */
  readHistory(window: HistoryWindow): Promise<readonly LocalHistoryEntry[]>;
}
