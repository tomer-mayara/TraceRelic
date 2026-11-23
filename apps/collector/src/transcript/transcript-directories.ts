import type { BigIntStats, Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";

export type DirectoryListing = (path: string, optional?: boolean) => Promise<Dirent[]>;

function missing(error: unknown, path: string): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT" && "path" in error && error.path === path;
}

export const listDirectory: DirectoryListing = async (path, optional) => {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (optional && missing(error, path)) return [];
    throw error;
  }
};

/** A file can move from an unread directory into one we already checked. Verify the directory observations before reporting absence. */
export class TranscriptDirectories {
  private readonly observed = new Map<string, BigIntStats | undefined>();

  static async absent(root: string | undefined, paths: readonly string[], locations: (list: DirectoryListing) => AsyncIterable<string>) {
    if (!root || !paths.length) return [];
    const search = new TranscriptDirectories();
    await search.list(root, true);
    if (!search.observed.get(root)) return [];
    const remaining = new Set(paths);
    for await (const path of locations((directory, optional) => search.list(directory, optional))) {
      remaining.delete(path);
      if (!remaining.size) return [];
    }
    return await search.unchanged() ? [...remaining] : [];
  }

  private async list(path: string, optional = false) {
    const directory = await this.inspect(path, optional);
    this.observed.set(path, directory);
    return directory ? listDirectory(path) : [];
  }

  private async inspect(path: string, optional: boolean) {
    try {
      return await stat(path, { bigint: true });
    } catch (error) {
      if (optional && missing(error, path)) return;
      throw error;
    }
  }

  private async unchanged(): Promise<boolean> {
    for (const [path, before] of this.observed) {
      const after = await this.inspect(path, true);
      if (before?.dev !== after?.dev || before?.ino !== after?.ino ||
        before?.mtimeNs !== after?.mtimeNs || before?.ctimeNs !== after?.ctimeNs) return false;
    }
    return true;
  }
}
