import { basename, dirname, join, relative } from "node:path";
import { matchesRecordedPath } from "@tracerelic/shared";
import type { GlobalConfig } from "../config/global-config.ts";
import { type DirectoryListing, listDirectory, TranscriptDirectories } from "./transcript-directories.ts";
import {
  LocalLLMHistory, type ClaudeSubagent, type LocalHistoryEntry, type ScanSelection, type SourceDiscoveryOptions, type Transcript, type TranscriptEntry, type TranscriptSource,
} from "./local-llm-history.ts";

export type ClaudeTranscriptEntry = TranscriptEntry<"claude">;

export interface ClaudeTranscript extends Transcript<ClaudeTranscriptEntry> {
  readonly previousCopy: boolean;
}

interface TranscriptFile {
  sourceFile: string;
  projectDir: string;
  currentFile?: string;
  subagent?: ClaudeSubagent;
}

interface SelectedSession {
  selected?: boolean;
  cwd?: string;
  subagent?: ClaudeSubagent;
}

export class LocalLLMHistoryClaude extends LocalLLMHistory {
  private readonly config: GlobalConfig;

  constructor(config: GlobalConfig) {
    super();
    this.config = config;
  }

  protected async readWindow(inRange: (timestamp: string) => boolean): Promise<readonly LocalHistoryEntry[]> {
    const entries: LocalHistoryEntry[] = [];
    for await (const file of this.transcriptFiles(false)) {
      for await (const { lineNumber, record } of this.readRecords(file.sourceFile)) {
        const { timestamp } = record;
        const sessionId = this.identity(record, file.subagent)?.sessionId;
        if (sessionId && typeof timestamp === "string" && inRange(timestamp)) {
          entries.push({ harness: "claude", sessionId, sourceFile: file.sourceFile, lineNumber, timestamp, record });
        }
      }
    }
    return entries;
  }

  async *readTranscripts(selection: ScanSelection = {}): AsyncGenerator<ClaudeTranscript> {
    for await (const source of this.discoverSources(selection)) {
      const transcript = await this.snapshot(source);
      if (transcript) yield { ...transcript, previousCopy: source.previousCopy };
    }
  }

  async *discoverSources(selection: ScanSelection = {}, options: SourceDiscoveryOptions = {}): AsyncGenerator<TranscriptSource<ClaudeTranscriptEntry>> {
    const previous: TranscriptFile[] = [];
    const currentCwds = new Map<string, string>();
    const target = options.sourceFile;
    const name = target && this.transcriptName(basename(target), true);
    const current = target && name && name.previousCopy ? join(dirname(target), name.stem + ".jsonl") : undefined;
    for await (const file of this.transcriptFiles(true)) {
      if (target && file.sourceFile !== target && file.sourceFile !== current) continue;
      if (file.currentFile) previous.push(file);
      else for await (const source of this.discoverFileSafely(this.discoverFile(file, selection, currentCwds), options)) {
        if (!target || source.sourceFile === target) yield source;
      }
    }
    for (const file of previous) yield* this.discoverFileSafely(this.backupSources(file, selection, currentCwds), options);
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
    const currentFilePath = currentFile && this.config.claudePath ? relative(this.config.claudePath, currentFile) : undefined;
    const selectedProject = selection.projectPaths?.some(path => matchesRecordedPath(path, file.projectDir, true));
    const requestedIds = selection.projectPaths?.length ? undefined : new Set(selection.sessionIds);
    // One file can contain several native IDs. Keep only each ID's selection by its first usable cwd.
    const sessions = new Map<string, SelectedSession>();
    let seekingCwd = false;
    const { file: captured } = await this.inspectFile(sourceFile, async records => {
      for await (const { record } of records) {
        const identity = this.identity(record, file.subagent);
        if (!identity) continue;
        const { sessionId, subagent } = identity;
        let session = sessions.get(sessionId);
        if (!session) {
          const inherited = currentFile ? currentCwds.get(`${currentFile}\0${sessionId}`) : undefined;
          const selected = selectedProject || this.selected(selection, sessionId, inherited);
          if (!selected && requestedIds) continue;
          session = { selected: selected ? true : undefined };
          sessions.set(sessionId, session);
        }
        session.subagent ??= subagent;
        session.cwd ??= this.workingDirectory(record.cwd);
        if (session.cwd && session.selected === undefined) {
          session.selected = this.selected(selection, sessionId, session.cwd);
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
      const source = this.transcriptSource({
        harness: "claude", sessionId, file: captured, previousCopy: currentFile !== undefined,
        projectDir: file.projectDir, selectionCwd: cwd ?? inherited,
        matches: record => this.identity(record, file.subagent)?.sessionId === sessionId,
      });
      yield { ...source, ...(subagent && { claudeSubagent: subagent }), ...(currentFilePath && { currentFilePath }),
        ...(inherited && cwd && inherited !== cwd && { currentFileCwd: inherited }) };
    }
  }

  /** Recheck backups of an acknowledged current path even if project selection no longer finds their cwd. */
  async *recoveryCandidates(paths: ReadonlySet<string>) {
    const root = this.config.claudePath;
    if (!root || !paths.size) return;
    for await (const file of this.transcriptFiles(true)) {
      if (!file.currentFile) continue;
      const currentPath = relative(root, file.currentFile);
      if (!paths.has(currentPath)) continue;
      const sources = await Array.fromAsync(this.discoverFileSafely(this.backupSources(file, {}, new Map()), { onChanged: () => {} }));
      yield { currentPath, path: relative(root, file.sourceFile), sources };
    }
  }

  confirmedAbsent(paths: readonly string[], excludedCopyPaths: readonly string[] = []): Promise<string[]> {
    const root = this.config.claudePath;
    return TranscriptDirectories.absent(root, paths, list => this.presencePaths(list, new Set(excludedCopyPaths)));
  }

  private async *presencePaths(list: DirectoryListing, excluded: ReadonlySet<string>) {
    const root = this.config.claudePath;
    if (!root) return;
    for await (const file of this.transcriptFiles(true, list)) {
      const path = relative(root, file.sourceFile);
      yield path;
      if (file.currentFile && !excluded.has(path)) yield relative(root, file.currentFile);
    }
  }

  private identity(record: LocalHistoryEntry["record"], directory?: ClaudeSubagent): { sessionId: string; subagent?: ClaudeSubagent } | undefined {
    const nativeId = record.sessionId;
    if (typeof nativeId !== "string" || !nativeId.length) return;
    if (!directory) return { sessionId: nativeId };
    const { parentSessionId } = directory;
    const agentId = typeof record.agentId === "string" && record.agentId ? record.agentId : directory.agentId;
    if (nativeId === parentSessionId) {
      return { sessionId: `${encodeURIComponent(nativeId)}/subagents/${encodeURIComponent(agentId)}`, subagent: { parentSessionId, agentId } };
    }
    // A physical file may contain records from an independent session. A native
    // sidechain or agent ID links that session to this parent.
    const linked = record.isSidechain === true || record.agentId === directory.agentId || nativeId === directory.agentId;
    return { sessionId: nativeId, ...(linked && { subagent: { parentSessionId, agentId } }) };
  }

  private async *transcriptFiles(scan: boolean, list = listDirectory): AsyncGenerator<TranscriptFile> {
    if (this.config.claudePath === undefined) return;
    const projects = join(this.config.claudePath, "projects");
    for (const project of await list(projects, true)) {
      if (!project.isDirectory()) continue;
      const projectDir = join(projects, project.name);
      for (const entry of await list(projectDir)) {
        const path = join(projectDir, entry.name);
        if (entry.isFile()) {
          const name = this.transcriptName(entry.name, scan);
          if (name) yield { sourceFile: path, projectDir, currentFile: name.previousCopy ? join(projectDir, name.stem + ".jsonl") : undefined };
        }
        if (!entry.isDirectory()) continue;
        const agents = join(path, "subagents");
        for (const file of await list(agents, true)) {
          if (!file.isFile()) continue;
          const name = this.transcriptName(file.name, scan);
          if (!name || !name.stem.startsWith("agent-") || name.stem.length <= "agent-".length) continue;
          yield {
            sourceFile: join(agents, file.name), projectDir,
            currentFile: name.previousCopy ? join(agents, name.stem + ".jsonl") : undefined,
            subagent: { parentSessionId: entry.name, agentId: name.stem.slice("agent-".length) },
          };
        }
      }
    }
  }

  private transcriptName(name: string, scan: boolean): { stem: string; previousCopy: boolean } | undefined {
    // Date queries keep their original .jsonl file set. A scan also recognizes earlier copies.
    if (scan) {
      const prior = /^(.+)\.orphaned-\d.*-.+\.jsonl$/.exec(name) ?? /^(.+)\.jsonl\.superseded-\d.*$/.exec(name);
      if (prior) return { stem: prior[1], previousCopy: true };
    }
    const current = /^(.+)\.jsonl$/.exec(name);
    if (current) return { stem: current[1], previousCopy: false };
  }
}
