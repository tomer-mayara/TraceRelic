import { readdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { GlobalConfig } from "../config/global-config.ts";
import {
  LocalLLMHistory, type LocalHistoryEntry, type ScanSelection, type Transcript, type TranscriptEntry, type TranscriptSource,
} from "./local-llm-history.ts";

export type ClaudeTranscriptEntry = TranscriptEntry<"claude">;

export interface ClaudeTranscript extends Transcript<ClaudeTranscriptEntry> {
  readonly previousCopy: boolean;
}

interface TranscriptFile {
  sourceFile: string;
  projectDir: string;
  currentFile?: string;
  subagent?: { parentId: string; agentId: string };
}

export class LocalLLMHistoryClaude extends LocalLLMHistory {
  private readonly config: GlobalConfig;

  constructor(config: GlobalConfig) {
    super();
    this.config = config;
  }

  async readLocalHistory(fromDate: Date, toDate: Date): Promise<readonly LocalHistoryEntry[]> {
    const inRange = this.dateFilter(fromDate, toDate);
    const entries: LocalHistoryEntry[] = [];
    for await (const file of this.transcriptFiles(false)) {
      for await (const { lineNumber, record } of this.readRecords(file.sourceFile)) {
        const { timestamp } = record;
        const sessionId = this.sessionId(record, file.subagent);
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

  async *discoverSources(selection: ScanSelection = {}): AsyncGenerator<TranscriptSource<ClaudeTranscriptEntry>> {
    const previous: TranscriptFile[] = [];
    const selectedFamilies = selection.projectPaths?.length ? new Set<string>() : undefined;
    for await (const file of this.transcriptFiles(true)) {
      if (file.currentFile) previous.push(file);
      else yield* this.discoverFile(file, selection, selectedFamilies);
    }
    for (const file of previous) yield* this.discoverFile(file, selection, selectedFamilies);
  }

  private async *discoverFile(
    file: TranscriptFile, selection: ScanSelection, selectedFamilies?: Set<string>,
  ): AsyncGenerator<TranscriptSource<ClaudeTranscriptEntry>> {
    const { sourceFile, currentFile } = file;
    const selectedProject = selection.projectPaths?.some(path => path.length > 0 && relative(path, file.projectDir) === "");
    const requestedIds = selectedFamilies ? undefined : new Set(selection.sessionIds);
    // One file can contain several native IDs. Keep only each ID's selection by its first usable cwd.
    const sessions = new Map<string, boolean | undefined>();
    const { file: captured } = await this.inspectFile(sourceFile, async records => {
      for await (const { record } of records) {
        const sessionId = this.sessionId(record, file.subagent);
        if (!sessionId) continue;
        if (!sessions.has(sessionId)) {
          const selected = selectedProject || this.selected(selection, sessionId, undefined)
            || (currentFile && selectedFamilies?.has(`${currentFile}\0${sessionId}`));
          if (!selected && !selectedFamilies) continue;
          sessions.set(sessionId, selected ? true : undefined);
        }
        const { cwd } = record;
        if (sessions.get(sessionId) === undefined && typeof cwd === "string" && isAbsolute(cwd) && !cwd.includes("\0")) {
          const selected = this.selected(selection, sessionId, cwd);
          sessions.set(sessionId, selected);
          if (selected && !currentFile) selectedFamilies?.add(`${sourceFile}\0${sessionId}`);
        }
        if (requestedIds?.size && sessions.size === requestedIds.size) break;
      }
    });
    for (const [sessionId, selected] of sessions) {
      if (selected) {
        yield this.transcriptSource({
          harness: "claude", sessionId, file: captured, previousCopy: currentFile !== undefined,
          matches: record => this.sessionId(record, file.subagent) === sessionId,
        });
      }
    }
  }

  private sessionId(record: LocalHistoryEntry["record"], subagent?: TranscriptFile["subagent"]): string | undefined {
    const nativeId = record.sessionId;
    if (typeof nativeId !== "string" || !nativeId.length) return;
    if (!subagent || nativeId !== subagent.parentId) return nativeId;
    const agentId = typeof record.agentId === "string" && record.agentId ? record.agentId : subagent.agentId;
    return `${encodeURIComponent(nativeId)}/subagents/${encodeURIComponent(agentId)}`;
  }

  private async *transcriptFiles(scan: boolean): AsyncGenerator<TranscriptFile> {
    if (this.config.claudePath === undefined) return;
    const projects = join(this.config.claudePath, "projects");
    for (const project of await this.listDirectoryIfPresent(projects)) {
      if (!project.isDirectory()) continue;
      const projectDir = join(projects, project.name);
      for (const entry of await readdir(projectDir, { withFileTypes: true })) {
        const path = join(projectDir, entry.name);
        if (entry.isFile()) {
          const name = this.transcriptName(entry.name, scan);
          if (name) yield { sourceFile: path, projectDir, currentFile: name.previousCopy ? join(projectDir, name.stem + ".jsonl") : undefined };
        }
        if (!entry.isDirectory()) continue;
        const agents = join(path, "subagents");
        for (const file of await this.listDirectoryIfPresent(agents)) {
          if (!file.isFile()) continue;
          const name = this.transcriptName(file.name, scan);
          if (!name || !name.stem.startsWith("agent-") || name.stem.length <= "agent-".length) continue;
          yield {
            sourceFile: join(agents, file.name), projectDir,
            currentFile: name.previousCopy ? join(agents, name.stem + ".jsonl") : undefined,
            subagent: { parentId: entry.name, agentId: name.stem.slice("agent-".length) },
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
