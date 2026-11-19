import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import type { GlobalConfig } from "../config/global-config.ts";
import { LocalLLMHistory, type LocalHistoryEntry } from "./local-llm-history.ts";

interface ClaudeTranscript {
  sourceFile: string;
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
    if (this.config.claudePath === undefined) return entries;
    const projects = join(this.config.claudePath, "projects");
    for await (const { sourceFile, subagent } of this.transcripts(projects)) {
      for await (const { lineNumber, record } of this.readRecords(sourceFile)) {
        const { sessionId: nativeId, timestamp } = record;
        if (typeof nativeId !== "string" || !nativeId || typeof timestamp !== "string" || !inRange(timestamp)) continue;
        let sessionId = nativeId;
        if (subagent && nativeId === subagent.parentId) {
          const agentId = typeof record.agentId === "string" && record.agentId ? record.agentId : subagent.agentId;
          sessionId = `${encodeURIComponent(nativeId)}/subagents/${encodeURIComponent(agentId)}`;
        }
        entries.push({ harness: "claude", sessionId, sourceFile, lineNumber, timestamp, record });
      }
    }
    return entries;
  }

  private async *transcripts(projects: string): AsyncGenerator<ClaudeTranscript> {
    for (const project of await this.listDirectoryIfPresent(projects)) {
      if (!project.isDirectory()) continue;
      const projectDir = join(projects, project.name);
      for (const entry of await readdir(projectDir, { withFileTypes: true })) {
        const path = join(projectDir, entry.name);
        if (entry.isFile() && extname(entry.name) === ".jsonl") yield { sourceFile: path };
        if (!entry.isDirectory()) continue;
        const agents = join(path, "subagents");
        for (const file of await this.listDirectoryIfPresent(agents)) {
          const match = /^agent-(.+)\.jsonl$/.exec(file.name);
          if (file.isFile() && match) {
            yield { sourceFile: join(agents, file.name), subagent: { parentId: entry.name, agentId: match[1] } };
          }
        }
      }
    }
  }
}
