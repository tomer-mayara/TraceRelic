import { createReadStream, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { GlobalConfig } from "../config/global-config.ts";
import { LocalLLMHistory, type LocalHistoryEntry } from "./local-llm-history.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
      let files: Dirent[];
      try {
        files = await readdir(root, { recursive: true, withFileTypes: true });
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT" && error.path === root) continue;
        throw error;
      }
      for (const file of files) {
        if (file.isFile() && /^rollout-.*\.jsonl$/.test(file.name)) {
          await this.readRollout(join(file.parentPath, file.name), inRange, entries);
        }
      }
    }
    return entries;
  }

  private async readRollout(sourceFile: string, inRange: (timestamp: string) => boolean, entries: LocalHistoryEntry[]): Promise<void> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let sessionId: string | undefined;
    let lineNumber = 0;
    for await (const line of this.completeLines(sourceFile)) {
      lineNumber++;
      let record: unknown;
      try {
        record = JSON.parse(decoder.decode(line));
      } catch {
        continue;
      }
      if (!isRecord(record)) continue;
      if (!sessionId && record.type === "session_meta" && isRecord(record.payload)) {
        const id = [record.payload.id, record.payload.session_id].find(value => typeof value === "string" && value.length > 0);
        if (typeof id === "string") sessionId = id;
      }
      const timestamp = record.timestamp;
      if (sessionId && typeof timestamp === "string" && inRange(timestamp)) {
        entries.push({ harness: "codex", sessionId, sourceFile, lineNumber, timestamp, record });
      }
    }
  }

  private async *completeLines(sourceFile: string): AsyncGenerator<Buffer> {
    const fragments: Buffer[] = [];
    const chunks: AsyncIterable<Buffer> = createReadStream(sourceFile);
    for await (const chunk of chunks) {
      let start = 0;
      for (let end = chunk.indexOf(0x0a); end >= 0; end = chunk.indexOf(0x0a, start)) {
        const part = chunk.subarray(start, end);
        yield fragments.length ? Buffer.concat([...fragments, part]) : part;
        fragments.length = 0;
        start = end + 1;
      }
      if (start < chunk.length) fragments.push(chunk.subarray(start));
    }
    // The writer may still be appending the unterminated final record.
  }
}
