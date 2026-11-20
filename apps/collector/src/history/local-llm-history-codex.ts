import { join } from "node:path";
import type { GlobalConfig } from "../config/global-config.ts";
import {
  LocalLLMHistory, type LocalHistoryEntry, type ScanSelection, type Transcript, type TranscriptEntry, type TranscriptSource,
} from "./local-llm-history.ts";

export type CodexSelection = ScanSelection;
export type CodexRolloutEntry = TranscriptEntry<"codex">;
export type CodexRollout = Transcript<CodexRolloutEntry>;

export class LocalLLMHistoryCodex extends LocalLLMHistory {
  private readonly config: GlobalConfig;

  constructor(config: GlobalConfig) {
    super();
    this.config = config;
  }

  async readLocalHistory(fromDate: Date, toDate: Date): Promise<readonly LocalHistoryEntry[]> {
    const inRange = this.dateFilter(fromDate, toDate);
    const entries: LocalHistoryEntry[] = [];
    for await (const sourceFile of this.rolloutFiles()) {
      let sessionId: string | undefined;
      for await (const { record, lineNumber } of this.readRecords(sourceFile)) {
        sessionId ??= this.header(record)?.sessionId;
        const { timestamp } = record;
        if (sessionId && typeof timestamp === "string" && inRange(timestamp)) {
          entries.push({ harness: "codex", sessionId, sourceFile, record, lineNumber, timestamp });
        }
      }
    }
    return entries;
  }

  async *readRollouts(selection: CodexSelection = {}): AsyncGenerator<CodexRollout> {
    for await (const source of this.discoverSources(selection)) {
      const rollout = await this.snapshot(source);
      if (rollout) yield rollout;
    }
  }

  async *discoverSources(selection: CodexSelection = {}): AsyncGenerator<TranscriptSource<CodexRolloutEntry>> {
    for await (const sourceFile of this.rolloutFiles()) {
      const source = await this.discoverRollout(sourceFile, selection);
      if (source) yield source;
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

  private async discoverRollout(sourceFile: string, selection: CodexSelection): Promise<TranscriptSource<CodexRolloutEntry> | undefined> {
    const { file, result: header } = await this.inspectFile(sourceFile, async records => {
      for await (const { record, lineNumber } of records) {
        const identity = this.header(record);
        if (identity) return { ...identity, lineNumber };
      }
    });
    if (!header || !this.selected(selection, header.sessionId, header.cwd)) return;
    return this.transcriptSource({
      harness: "codex", sessionId: header.sessionId, file, previousCopy: false,
      matches: (_record, lineNumber) => lineNumber >= header.lineNumber,
    });
  }

  private header(record: LocalHistoryEntry["record"]): { sessionId: string; cwd: unknown } | undefined {
    if (record.type !== "session_meta" || !this.isRecord(record.payload)) return;
    const { id, session_id, cwd } = record.payload;
    const sessionId = [id, session_id].find((value): value is string => typeof value === "string" && value.length > 0);
    if (sessionId) return { sessionId, cwd };
  }
}
