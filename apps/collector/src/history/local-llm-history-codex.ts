import { join } from "node:path";
import type { GlobalConfig } from "../config/global-config.ts";
import { LocalLLMHistory, type LocalHistoryEntry } from "./local-llm-history.ts";

export class LocalLLMHistoryCodex extends LocalLLMHistory {
  private readonly config: GlobalConfig;

  constructor(config: GlobalConfig) {
    super();
    this.config = config;
  }

  async readLocalHistory(fromDate: Date, toDate: Date): Promise<readonly LocalHistoryEntry[]> {
    const inRange = this.dateFilter(fromDate, toDate);
    const entries: LocalHistoryEntry[] = [];
    for (const directory of ["sessions", "archived_sessions"]) {
      const root = join(this.config.codexPath, directory);
      for (const file of await this.listDirectoryIfPresent(root, true)) {
        if (file.isFile() && /^rollout-.*\.jsonl$/.test(file.name)) {
          await this.readRollout(join(file.parentPath, file.name), inRange, entries);
        }
      }
    }
    return entries;
  }

  private async readRollout(sourceFile: string, inRange: (timestamp: string) => boolean, entries: LocalHistoryEntry[]): Promise<void> {
    let sessionId: string | undefined;
    for await (const { lineNumber, record } of this.readRecords(sourceFile)) {
      if (!sessionId && record.type === "session_meta" && this.isRecord(record.payload)) {
        const id = [record.payload.id, record.payload.session_id].find(value => typeof value === "string" && value.length > 0);
        if (typeof id === "string") sessionId = id;
      }
      const timestamp = record.timestamp;
      if (sessionId && typeof timestamp === "string" && inRange(timestamp)) {
        entries.push({ harness: "codex", sessionId, sourceFile, lineNumber, timestamp, record });
      }
    }
  }
}
