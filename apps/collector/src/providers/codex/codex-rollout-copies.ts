import { TranscriptChangedError, type SourceDiscoveryOptions, type TranscriptSource } from "../../transcript/index.ts";

export interface CodexCopy<T> {
  readonly file: Pick<TranscriptSource<unknown>, "fileSize" | "prefixDigests" | "sourceFile">;
  readonly sessionId?: string;
  readonly value: T;
}

/** Selects from the plain and compressed copies of one Codex rollout that have the same name. */
export class CodexRolloutCopies {
  /** Compare same-name physical forms at the shorter logical extent, including its unfinished suffix. */
  static async compatible<T>(copies: CodexCopy<T>[], options: SourceDiscoveryOptions = {}): Promise<T[]> {
    const checked: (CodexCopy<T> & { compressed: boolean; digests: Map<number, string> })[] = [];
    for (const copy of copies) {
      const { file, sessionId } = copy;
      const offsets = new Set(copies.filter(other => other.sessionId === sessionId && other.file.fileSize <= file.fileSize)
        .map(other => other.file.fileSize));
      try {
        const hashes = await file.prefixDigests([...offsets]);
        checked.push({ ...copy, compressed: file.sourceFile.endsWith(".zst"), digests: new Map(hashes.map(row => [row.offset, row.prefixDigest])) });
      } catch (error) {
        if (!(error instanceof TranscriptChangedError) || !options.onChanged) throw error;
        options.onChanged(error);
      }
    }
    return checked.filter(copy => !checked.some(other => other.compressed !== copy.compressed && other.sessionId === copy.sessionId
      && (other.file.fileSize > copy.file.fileSize || (other.file.fileSize === copy.file.fileSize && !other.compressed))
      && other.digests.get(copy.file.fileSize) === copy.digests.get(copy.file.fileSize))).map(copy => copy.value);
  }
}
