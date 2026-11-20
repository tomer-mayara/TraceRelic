import { basename, join } from "node:path";
import type { GlobalConfig } from "../config/global-config.ts";
import { compatibleCodexCopies, type CodexCopy } from "./codex-rollout-copies.ts";
import { type DirectoryListing, listDirectory, TranscriptDirectories } from "./transcript-directories.ts";
import {
  LocalLLMHistory, type LocalHistoryEntry, type ScanSelection, type SourceDiscoveryOptions, type Transcript, type TranscriptEntry, type TranscriptSource,
} from "./local-llm-history.ts";

export type CodexSelection = ScanSelection;
export type CodexRolloutEntry = TranscriptEntry<"codex">;
export type CodexRollout = Transcript<CodexRolloutEntry>;

export function codexRolloutName(sourceFile: string): string {
  return basename(sourceFile).replace(/\.jsonl\.zst$/, ".jsonl");
}

export class LocalLLMHistoryCodex extends LocalLLMHistory {
  private readonly config: GlobalConfig;

  constructor(config: GlobalConfig) {
    super();
    this.config = config;
  }

  protected async readWindow(inRange: (timestamp: string) => boolean): Promise<readonly LocalHistoryEntry[]> {
    const entries: LocalHistoryEntry[] = [];
    for await (const { paths, mixed } of this.representations()) {
      const copies: CodexCopy<LocalHistoryEntry[]>[] = [];
      for (const sourceFile of paths) {
        if (mixed) {
          const { file, result } = await this.inspectFile(sourceFile, rows => this.dateRecords(sourceFile, rows, inRange));
          copies.push({ file, sessionId: result.sessionId, value: result.entries });
        } else {
          const result = await this.dateRecords(sourceFile, this.readRecords(sourceFile), inRange);
          for (const row of result.entries) entries.push(row);
        }
      }
      for (const result of await compatibleCodexCopies(copies)) for (const row of result) entries.push(row);
    }
    return entries;
  }

  private async dateRecords(sourceFile: string, rows: AsyncIterable<Pick<LocalHistoryEntry, "record" | "lineNumber">>, inRange: (at: string) => boolean) {
    const entries: LocalHistoryEntry[] = [];
    let sessionId: string | undefined;
    for await (const { record, lineNumber } of rows) {
      sessionId ??= this.header(record)?.sessionId;
      const { timestamp } = record;
      if (sessionId && typeof timestamp === "string" && inRange(timestamp)) {
        entries.push({ harness: "codex", sessionId, sourceFile, record, lineNumber, timestamp });
      }
    }
    return { entries, sessionId };
  }

  async *readRollouts(selection: CodexSelection = {}): AsyncGenerator<CodexRollout> {
    for await (const source of this.discoverSources(selection)) {
      const rollout = await this.snapshot(source);
      if (rollout) yield rollout;
    }
  }

  async *discoverSources(selection: CodexSelection = {}, options: SourceDiscoveryOptions = {}): AsyncGenerator<TranscriptSource<CodexRolloutEntry>> {
    for await (const { paths, mixed } of this.representations(options.sourceFile)) {
      const copies: CodexCopy<TranscriptSource<CodexRolloutEntry>>[] = [];
      for (const sourceFile of paths) {
        for await (const source of this.discoverFileSafely(this.discoverRollout(sourceFile, selection), options)) {
          if (mixed) copies.push({ file: source, sessionId: source.sessionId, value: source });
          else yield source;
        }
      }
      yield* await compatibleCodexCopies(copies, options);
    }
  }

  confirmedAbsent(paths: readonly string[]): Promise<string[]> {
    return TranscriptDirectories.absent(this.config.codexPath, paths, list => this.rolloutNames(list));
  }

  /** A session-only scan may inspect the native ID at an old location without importing the other chat. */
  async *identitiesAt(paths: ReadonlySet<string>): AsyncGenerator<{ path: string; sessionId: string }> {
    for await (const sourceFile of this.rolloutFiles()) {
      const path = codexRolloutName(sourceFile);
      if (!paths.has(path)) continue;
      for await (const source of this.discoverFileSafely(this.discoverRollout(sourceFile, {}), { onChanged: () => {} })) {
        yield { path, sessionId: source.sessionId };
      }
    }
  }

  private async *rolloutNames(list: DirectoryListing) {
    for await (const path of this.rolloutFiles(list)) yield codexRolloutName(path);
  }

  private async *rolloutFiles(list = listDirectory): AsyncGenerator<string> {
    for (const name of ["sessions", "archived_sessions"]) {
      yield* this.rolloutsIn(join(this.config.codexPath, name), list, true);
    }
  }

  private async *representations(selected?: string) {
    const groups = new Map<string, string[]>();
    for await (const file of this.rolloutFiles()) {
      const name = codexRolloutName(file);
      if (selected && name !== codexRolloutName(selected)) continue;
      const paths = groups.get(name) ?? [];
      paths.push(file);
      groups.set(name, paths);
    }
    for (const paths of groups.values()) {
      const plain = paths.filter(path => !path.endsWith(".zst"));
      const compressed = paths.filter(path => path.endsWith(".zst"));
      yield { paths: [...plain, ...compressed], mixed: plain.length > 0 && compressed.length > 0 };
    }
  }

  private async *rolloutsIn(directory: string, list: DirectoryListing, optional = false): AsyncGenerator<string> {
    const entries = await list(directory, optional);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) yield* this.rolloutsIn(path, list);
      else if (entry.isFile() && /^rollout-.*\.jsonl(?:\.zst)?$/.test(entry.name)) yield path;
    }
  }

  private async *discoverRollout(sourceFile: string, selection: CodexSelection): AsyncGenerator<TranscriptSource<CodexRolloutEntry>> {
    const { file, result: header } = await this.inspectFile(sourceFile, async records => {
      for await (const { record, lineNumber, endOffset, afterBlankPrefix } of records) {
        const identity = this.header(record);
        if (identity) return { ...identity, lineNumber, endOffset, blankPrefixHeaderEnd: afterBlankPrefix ? endOffset : undefined };
      }
    });
    if (!header || !this.selected(selection, header.sessionId, header.cwd)) return;
    const source = this.transcriptSource({
      harness: "codex", sessionId: header.sessionId, file, previousCopy: false, selectionCwd: this.workingDirectory(header.cwd),
      blankPrefixHeaderEnd: header.blankPrefixHeaderEnd,
      matches: (_record, lineNumber) => lineNumber >= header.lineNumber,
    });
    yield { ...source, codexHeaderEnd: header.endOffset, ...(header.codexForkHeader && { codexForkHeader: header.codexForkHeader }) };
  }

  private header(record: LocalHistoryEntry["record"]) {
    if (record.type !== "session_meta" || !this.isRecord(record.payload)) return;
    const { id, session_id, cwd, source, timestamp } = record.payload;
    const sessionId = [id, session_id].find((value): value is string => typeof value === "string" && value.length > 0);
    if (!sessionId) return;
    const agent = this.isRecord(source) && this.isRecord(source.subagent) ? source.subagent.thread_spawn : undefined;
    const parentSessionId = [record.payload.forked_from_id, this.isRecord(agent) && agent.parent_thread_id,
      record.payload.forked_from_session_id, record.payload.forked_from, record.payload.parent_session_id, record.payload.parent_thread_id]
      .find((value): value is string => typeof value === "string" && value.length > 0);
    const at = timestamp ?? record.timestamp;
    const codexForkHeader = parentSessionId ? { parentSessionId, ...(this.hasRecordedTimestamp(at) && { forkedAt: at }) } : undefined;
    return { sessionId, cwd, codexForkHeader };
  }
}
