import type { HistoryProvider, LocalHistoryEntry } from "./history-provider.ts";
import { HistoryWindow } from "./history-window.ts";

/** Reads one window from each provider that it receives. Returns the entries in the sequence of the providers. */
export class LocalLLMHistory {
  constructor(private readonly providers: readonly HistoryProvider[]) {}

  async readLocalHistory(fromDate: Date, toDate: Date): Promise<readonly LocalHistoryEntry[]> {
    return this.readWindow(HistoryWindow.between(fromDate, toDate));
  }

  async readLocalHistoryInstants(from: string, to: string): Promise<readonly LocalHistoryEntry[]> {
    return this.readWindow(HistoryWindow.betweenInstants(from, to));
  }

  private async readWindow(window: HistoryWindow): Promise<readonly LocalHistoryEntry[]> {
    const entries = await Promise.all(this.providers.map(provider => provider.readHistory(window)));
    return entries.flat();
  }
}
