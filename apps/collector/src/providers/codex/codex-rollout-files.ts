import { basename, join } from "node:path";
import { type DirectoryListing, listDirectory } from "../../transcript/transcript-directories.ts";

/** Codex rollouts in sessions/ and archived_sessions/, as plain files and as .zst files. */
export class CodexRolloutFiles {
  constructor(private readonly root: string) {}

  /** The same logical name for the plain file and the .zst file of a rollout. */
  static logicalName(sourceFile: string): string {
    return basename(sourceFile).replace(/\.jsonl\.zst$/, ".jsonl");
  }

  async *rolloutNames(list: DirectoryListing) {
    for await (const path of this.rolloutFiles(list)) yield CodexRolloutFiles.logicalName(path);
  }

  async *rolloutFiles(list = listDirectory): AsyncGenerator<string> {
    for (const name of ["sessions", "archived_sessions"]) {
      yield* this.rolloutsIn(join(this.root, name), list, true);
    }
  }

  async *representations(selected?: string) {
    const groups = new Map<string, string[]>();
    for await (const file of this.rolloutFiles()) {
      const name = CodexRolloutFiles.logicalName(file);
      if (selected && name !== CodexRolloutFiles.logicalName(selected)) continue;
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
}
