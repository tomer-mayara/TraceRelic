import { join } from "node:path";
import { claudeCopyStem } from "@tracerelic/shared";
import type { ClaudeSubagent } from "../../transcript/index.ts";
import { listDirectory } from "../../transcript/transcript-directories.ts";

export interface TranscriptFile {
  sourceFile: string;
  projectDir: string;
  currentFile?: string;
  subagent?: ClaudeSubagent;
}

/** Claude Code transcripts in projects/ and subagents/, and their earlier copies. */
export class ClaudeTranscriptFiles {
  constructor(private readonly root: string) {}

  async *transcriptFiles(scan: boolean, list = listDirectory): AsyncGenerator<TranscriptFile> {
    const projects = join(this.root, "projects");
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

  transcriptName(name: string, scan: boolean): { stem: string; previousCopy: boolean } | undefined {
    // Date queries keep their original .jsonl file set. A scan also recognizes earlier copies.
    if (scan) {
      const stem = claudeCopyStem(name);
      if (stem) return { stem, previousCopy: true };
    }
    const current = /^(.+)\.jsonl$/.exec(name);
    if (current) return { stem: current[1], previousCopy: false };
  }
}
