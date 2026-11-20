import { join } from "node:path";
import type { GlobalConfig } from "../config/global-config.ts";
import { LocalLLMHistory, type LocalHistoryEntry, type ScanSelection, type Transcript, type TranscriptEntry } from "./local-llm-history.ts";

export type CodexSelection = ScanSelection;
export type CodexRolloutEntry = TranscriptEntry<"codex">;
export type CodexRollout = Transcript<CodexRolloutEntry>;

type SourceEntry = Omit<CodexRolloutEntry, "endOffset" | "timestamp">;

export class LocalLLMHistoryCodex extends LocalLLMHistory {
  private readonly config: GlobalConfig;

  constructor(config: GlobalConfig) {
    super();
    this.config = config;
  }

  async readLocalHistory(fromDate: Date, toDate: Date): Promise<readonly LocalHistoryEntry[]> {
    const inRange = this.dateFilter(fromDate, toDate);
    const entries: LocalHistoryEntry[] = [];
    for await (const file of this.rolloutFiles()) {
      await this.readRollout(file, {}, entry => {
        const { timestamp } = entry.record;
        if (typeof timestamp === "string" && inRange(timestamp)) entries.push({ ...entry, timestamp });
      });
    }
    return entries;
  }

  async *readRollouts(selection: CodexSelection = {}): AsyncGenerator<CodexRollout> {
    for await (const sourceFile of this.rolloutFiles()) {
      const entries: CodexRolloutEntry[] = [];
      const source = await this.readRollout(sourceFile, selection, (entry, endOffset) => {
        const { timestamp } = entry.record;
        entries.push({ ...entry, endOffset, ...(this.hasRecordedTimestamp(timestamp) ? { timestamp } : {}) });
      });
      if (source) yield { ...source, sourceFile, entries };
    }
  }

  private async *rolloutFiles(): AsyncGenerator<string> {
    for (const name of ["sessions", "archived_sessions"]) {
      yield* this.rolloutsIn(join(this.config.codexPath, name));
    }
  }

  private async *rolloutsIn(directory: string): AsyncGenerator<string> {
    for (const entry of await this.listDirectoryIfPresent(directory)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) yield* this.rolloutsIn(path);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) yield path;
    }
  }

  private async readRollout(
    sourceFile: string, selection: CodexSelection, visit: (entry: SourceEntry, endOffset: number) => void,
  ): Promise<Pick<CodexRollout, "sessionId" | "endOffset"> | undefined> {
    let sessionId: string | undefined;
    let endOffset = 0;
    for await (const row of this.readRecords(sourceFile)) {
      const { lineNumber, record } = row;
      if (sessionId === undefined) {
        if (record.type !== "session_meta" || !this.isRecord(record.payload)) continue;
        const { id, session_id, cwd } = record.payload;
        sessionId = [id, session_id].find((value): value is string => typeof value === "string" && value.length > 0);
        if (sessionId === undefined) continue;
        if (!this.selected(selection, sessionId, cwd)) return;
      }
      visit({ harness: "codex", sessionId, sourceFile, lineNumber, record }, row.endOffset);
      endOffset = row.endOffset;
    }
    if (sessionId !== undefined) return { sessionId, endOffset };
  }
}
