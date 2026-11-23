import { matchesRecordedPath, recordedPathDialect } from "@tracerelic/shared";
import { TranscriptChangedError } from "./captured-transcript-file.ts";
import type { ScanSelection, SourceDiscoveryOptions } from "./transcript-source.ts";

/** Selects sessions by ID or project during source discovery. Sends a file that changes during discovery to onChanged. */
export class SourceDiscovery {
  static async *discoverFileSafely<T>(file: AsyncIterable<T>, options: SourceDiscoveryOptions): AsyncGenerator<T> {
    try {
      yield* file;
    } catch (error) {
      if (!(error instanceof TranscriptChangedError) || !options.onChanged) throw error;
      options.onChanged(error);
    }
  }

  static selected({ sessionIds = [], projectPaths = [] }: ScanSelection, sessionId: string, cwd: unknown): boolean {
    if (!sessionIds.length && !projectPaths.length) return true;
    if (sessionIds.includes(sessionId)) return true;
    return projectPaths.some(root => matchesRecordedPath(root, cwd));
  }

  static workingDirectory(value: unknown): string | undefined {
    if (typeof value === "string" && recordedPathDialect(value)) return value;
  }
}
