import { basename, dirname, join, relative } from "node:path";
import { matchesRecordedPath } from "@tracerelic/shared";
import type { HistoryProvider, HistoryWindow, LocalHistoryEntry } from "../../history/index.ts";
import type {
  ClaudeSubagent, ScanSelection, SourceDiscoveryOptions, Transcript, TranscriptEntry, TranscriptSource,
} from "../../transcript/index.ts";
import { JsonlRecords } from "../../transcript/jsonl-records.ts";
import { SourceDiscovery } from "../../transcript/source-discovery.ts";
import { TranscriptBatches } from "../../transcript/transcript-batches.ts";
import { type DirectoryListing, TranscriptDirectories } from "../../transcript/transcript-directories.ts";
import type { ScanProvider } from "../../scan/scan-provider.ts";
import { ClaudeScan } from "./claude-scan.ts";
import { ClaudeSessionIdentity } from "./claude-session-identity.ts";
import { ClaudeTranscriptFiles, type TranscriptFile } from "./claude-transcript-files.ts";

export type ClaudeTranscriptEntry = TranscriptEntry<"claude">;

export interface ClaudeTranscript extends Transcript<ClaudeTranscriptEntry> {
  readonly previousCopy: boolean;
}

interface SelectedSession {
  selected?: boolean;
  cwd?: string;
  subagent?: ClaudeSubagent;
}

/** The Claude Code provider. It receives the Claude Code root directory. */
export class ClaudeHistory implements HistoryProvider, ScanProvider<ClaudeTranscriptEntry> {
  readonly harness = "claude";
  private readonly jsonl = new JsonlRecords();
  private readonly batches = new TranscriptBatches(this.jsonl);
  private readonly files: ClaudeTranscriptFiles;

  constructor(readonly root: string) {
    this.files = new ClaudeTranscriptFiles(root);
  }

  openScan(selection: ScanSelection): ClaudeScan {
    return new ClaudeScan(this, selection);
  }

  async readHistory(window: HistoryWindow): Promise<readonly LocalHistoryEntry[]> {
    const entries: LocalHistoryEntry[] = [];
    for await (const file of this.files.transcriptFiles(false)) {
      for await (const { lineNumber, record } of this.jsonl.readRecords(file.sourceFile)) {
        const { timestamp } = record;
        const sessionId = ClaudeSessionIdentity.parse(record, file.subagent)?.sessionId;
        if (sessionId && typeof timestamp === "string" && window.contains(timestamp)) {
          entries.push({ harness: "claude", sessionId, sourceFile: file.sourceFile, lineNumber, timestamp, record });
        }
      }
    }
    return entries;
  }

  async *readTranscripts(selection: ScanSelection = {}): AsyncGenerator<ClaudeTranscript> {
    for await (const source of this.discoverSources(selection)) {
      const transcript = await this.batches.snapshot(source);
      if (transcript) yield { ...transcript, previousCopy: source.previousCopy };
    }
  }

  async *discoverSources(selection: ScanSelection = {}, options: SourceDiscoveryOptions = {}): AsyncGenerator<TranscriptSource<ClaudeTranscriptEntry>> {
    const previous: TranscriptFile[] = [];
    const currentCwds = new Map<string, string>();
    const target = options.sourceFile;
    const name = target && this.files.transcriptName(basename(target), true);
    const current = target && name && name.previousCopy ? join(dirname(target), name.stem + ".jsonl") : undefined;
    for await (const file of this.files.transcriptFiles(true)) {
      if (target && file.sourceFile !== target && file.sourceFile !== current) continue;
      if (file.currentFile) previous.push(file);
      else for await (const source of SourceDiscovery.discoverFileSafely(this.discoverFile(file, selection, currentCwds), options)) {
        if (!target || source.sourceFile === target) yield source;
      }
    }
    for (const file of previous) yield* SourceDiscovery.discoverFileSafely(this.backupSources(file, selection, currentCwds), options);
  }

  private async *backupSources(file: TranscriptFile, selection: ScanSelection, currentCwds: Map<string, string>) {
    try {
      yield* this.discoverFile(file, selection, currentCwds);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM"))) throw error;
      // Directory discovery still sees the backup. Its unreadable contents cannot establish absence.
    }
  }

  private async *discoverFile(
    file: TranscriptFile, selection: ScanSelection, currentCwds: Map<string, string>,
  ): AsyncGenerator<TranscriptSource<ClaudeTranscriptEntry>> {
    const { sourceFile, currentFile } = file;
    const currentFilePath = currentFile ? relative(this.root, currentFile) : undefined;
    const selectedProject = selection.projectPaths?.some(path => matchesRecordedPath(path, file.projectDir, true));
    const requestedIds = selection.projectPaths?.length ? undefined : new Set(selection.sessionIds);
    // One file can contain several native IDs. Keep only each ID's selection by its first usable cwd.
    const sessions = new Map<string, SelectedSession>();
    let seekingCwd = false;
    const { file: captured } = await this.jsonl.inspectFile(sourceFile, async records => {
      for await (const { record } of records) {
        const identity = ClaudeSessionIdentity.parse(record, file.subagent);
        if (!identity) continue;
        const { sessionId, subagent } = identity;
        let session = sessions.get(sessionId);
        if (!session) {
          const inherited = currentFile ? currentCwds.get(`${currentFile}\0${sessionId}`) : undefined;
          const selected = selectedProject || SourceDiscovery.selected(selection, sessionId, inherited);
          if (!selected && requestedIds) continue;
          session = { selected: selected ? true : undefined };
          sessions.set(sessionId, session);
        }
        session.subagent ??= subagent;
        session.cwd ??= SourceDiscovery.workingDirectory(record.cwd);
        if (session.cwd && session.selected === undefined) {
          session.selected = SourceDiscovery.selected(selection, sessionId, session.cwd);
        }
        if (requestedIds?.size && sessions.size === requestedIds.size) {
          // A copied row can precede the native agent identity in a nested file.
          const found = [...sessions.values()];
          if (!file.subagent || found.every(item => item.subagent)) {
            if (found.every(item => item.cwd)) break;
            seekingCwd = true;
          }
        }
      }
    }, line => !seekingCwd || line.includes('"cwd"') || line.includes("\\u"));
    for (const [sessionId, { selected, cwd, subagent }] of sessions) {
      if (!currentFile && cwd) currentCwds.set(`${sourceFile}\0${sessionId}`, cwd);
      if (!selected) continue;
      const inherited = currentFile ? currentCwds.get(`${currentFile}\0${sessionId}`) : undefined;
      const source = this.batches.transcriptSource({
        harness: "claude", sessionId, file: captured, previousCopy: currentFile !== undefined,
        projectDir: file.projectDir, selectionCwd: cwd ?? inherited,
        matches: record => ClaudeSessionIdentity.parse(record, file.subagent)?.sessionId === sessionId,
      });
      yield { ...source, ...(subagent && { claudeSubagent: subagent }), ...(currentFilePath && { currentFilePath }),
        ...(inherited && cwd && inherited !== cwd && { currentFileCwd: inherited }) };
    }
  }

  /** Recheck backups of an acknowledged current path even if project selection no longer finds their cwd. */
  async *recoveryCandidates(paths: ReadonlySet<string>) {
    if (!paths.size) return;
    for await (const file of this.files.transcriptFiles(true)) {
      if (!file.currentFile) continue;
      const currentPath = relative(this.root, file.currentFile);
      if (!paths.has(currentPath)) continue;
      const sources = await Array.fromAsync(SourceDiscovery.discoverFileSafely(this.backupSources(file, {}, new Map()), { onChanged: () => {} }));
      yield { currentPath, path: relative(this.root, file.sourceFile), sources };
    }
  }

  confirmedAbsent(paths: readonly string[], excludedCopyPaths: readonly string[] = []): Promise<string[]> {
    return TranscriptDirectories.absent(this.root, paths, list => this.presencePaths(list, new Set(excludedCopyPaths)));
  }

  private async *presencePaths(list: DirectoryListing, excluded: ReadonlySet<string>) {
    for await (const file of this.files.transcriptFiles(true, list)) {
      const path = relative(this.root, file.sourceFile);
      yield path;
      if (file.currentFile && !excluded.has(path)) yield relative(this.root, file.currentFile);
    }
  }
}
