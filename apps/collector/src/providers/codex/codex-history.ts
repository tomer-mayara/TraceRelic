import type { HistoryProvider, HistoryWindow, LocalHistoryEntry } from "../../history/index.ts";
import type { ScanSelection, SourceDiscoveryOptions, Transcript, TranscriptEntry, TranscriptSource } from "../../transcript/index.ts";
import { JsonlRecords } from "../../transcript/jsonl-records.ts";
import { SourceDiscovery } from "../../transcript/source-discovery.ts";
import { TranscriptBatches } from "../../transcript/transcript-batches.ts";
import { TranscriptDirectories } from "../../transcript/transcript-directories.ts";
import { CodexRolloutCopies, type CodexCopy } from "./codex-rollout-copies.ts";
import { CodexRolloutFiles } from "./codex-rollout-files.ts";
import { CodexSessionHeader } from "./codex-session-header.ts";

export type CodexSelection = ScanSelection;
export type CodexRolloutEntry = TranscriptEntry<"codex">;
export type CodexRollout = Transcript<CodexRolloutEntry>;

/** The Codex provider. It receives the Codex root directory. */
export class CodexHistory implements HistoryProvider {
  readonly harness = "codex";
  private readonly jsonl = new JsonlRecords();
  private readonly batches = new TranscriptBatches(this.jsonl);
  private readonly files: CodexRolloutFiles;

  constructor(private readonly root: string) {
    this.files = new CodexRolloutFiles(root);
  }

  async readHistory(window: HistoryWindow): Promise<readonly LocalHistoryEntry[]> {
    const entries: LocalHistoryEntry[] = [];
    for await (const { paths, mixed } of this.files.representations()) {
      const copies: CodexCopy<LocalHistoryEntry[]>[] = [];
      for (const sourceFile of paths) {
        if (mixed) {
          const { file, result } = await this.jsonl.inspectFile(sourceFile, rows => this.dateRecords(sourceFile, rows, window));
          copies.push({ file, sessionId: result.sessionId, value: result.entries });
        } else {
          const result = await this.dateRecords(sourceFile, this.jsonl.readRecords(sourceFile), window);
          for (const row of result.entries) entries.push(row);
        }
      }
      for (const result of await CodexRolloutCopies.compatible(copies)) for (const row of result) entries.push(row);
    }
    return entries;
  }

  private async dateRecords(sourceFile: string, rows: AsyncIterable<Pick<LocalHistoryEntry, "record" | "lineNumber">>, window: HistoryWindow) {
    const entries: LocalHistoryEntry[] = [];
    let sessionId: string | undefined;
    for await (const { record, lineNumber } of rows) {
      sessionId ??= CodexSessionHeader.parse(record)?.sessionId;
      const { timestamp } = record;
      if (sessionId && typeof timestamp === "string" && window.contains(timestamp)) {
        entries.push({ harness: "codex", sessionId, sourceFile, record, lineNumber, timestamp });
      }
    }
    return { entries, sessionId };
  }

  async *readRollouts(selection: CodexSelection = {}): AsyncGenerator<CodexRollout> {
    for await (const source of this.discoverSources(selection)) {
      const rollout = await this.batches.snapshot(source);
      if (rollout) yield rollout;
    }
  }

  async *discoverSources(selection: CodexSelection = {}, options: SourceDiscoveryOptions = {}): AsyncGenerator<TranscriptSource<CodexRolloutEntry>> {
    for await (const { paths, mixed } of this.files.representations(options.sourceFile)) {
      const copies: CodexCopy<TranscriptSource<CodexRolloutEntry>>[] = [];
      for (const sourceFile of paths) {
        for await (const source of SourceDiscovery.discoverFileSafely(this.discoverRollout(sourceFile, selection), options)) {
          if (mixed) copies.push({ file: source, sessionId: source.sessionId, value: source });
          else yield source;
        }
      }
      yield* await CodexRolloutCopies.compatible(copies, options);
    }
  }

  confirmedAbsent(paths: readonly string[]): Promise<string[]> {
    return TranscriptDirectories.absent(this.root, paths, list => this.files.rolloutNames(list));
  }

  /** A session-only scan may inspect the native ID at an old location without importing the other chat. */
  async *identitiesAt(paths: ReadonlySet<string>): AsyncGenerator<{ path: string; sessionId: string }> {
    for await (const sourceFile of this.files.rolloutFiles()) {
      const path = CodexRolloutFiles.logicalName(sourceFile);
      if (!paths.has(path)) continue;
      for await (const source of SourceDiscovery.discoverFileSafely(this.discoverRollout(sourceFile, {}), { onChanged: () => {} })) {
        yield { path, sessionId: source.sessionId };
      }
    }
  }

  private async *discoverRollout(sourceFile: string, selection: CodexSelection): AsyncGenerator<TranscriptSource<CodexRolloutEntry>> {
    const { file, result: header } = await this.jsonl.inspectFile(sourceFile, async records => {
      for await (const { record, lineNumber, endOffset, afterBlankPrefix } of records) {
        const identity = CodexSessionHeader.parse(record);
        if (identity) return { ...identity, lineNumber, endOffset, blankPrefixHeaderEnd: afterBlankPrefix ? endOffset : undefined };
      }
    });
    if (!header || !SourceDiscovery.selected(selection, header.sessionId, header.cwd)) return;
    const source = this.batches.transcriptSource({
      harness: "codex", sessionId: header.sessionId, file, previousCopy: false, selectionCwd: SourceDiscovery.workingDirectory(header.cwd),
      blankPrefixHeaderEnd: header.blankPrefixHeaderEnd,
      matches: (_record, lineNumber) => lineNumber >= header.lineNumber,
    });
    yield { ...source, codexHeaderEnd: header.endOffset, ...(header.codexForkHeader && { codexForkHeader: header.codexForkHeader }) };
  }
}
