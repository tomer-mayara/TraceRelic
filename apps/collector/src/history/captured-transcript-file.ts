import type { BigIntStats } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";

export class TranscriptChangedError extends Error {
  constructor(readonly sourceFile: string, cause?: unknown) {
    super(`Transcript changed while reading ${sourceFile}`, { cause });
    this.name = "TranscriptChangedError";
  }
}

export class CapturedTranscriptFile {
  readonly fileSize: number;

  private constructor(readonly sourceFile: string, private readonly identity: BigIntStats) {
    this.fileSize = Number(identity.size);
    if (!Number.isSafeInteger(this.fileSize)) throw new RangeError(`Transcript exceeds the supported byte range: ${sourceFile}`);
  }

  static async inspect<T>(sourceFile: string, inspect: (chunks: AsyncIterable<Buffer>) => Promise<T>) {
    const handle = await open(sourceFile, "r");
    try {
      const file = new CapturedTranscriptFile(sourceFile, await handle.stat({ bigint: true }));
      const result = await inspect(file.readRange(handle, 0, file.fileSize));
      await file.verifyPath();
      return { file, result };
    } finally {
      await handle.close();
    }
  }

  async *chunks(start: number, end: number): AsyncGenerator<Buffer> {
    const handle = await open(this.sourceFile, "r").catch(error => this.rethrowMissing(error));
    try {
      this.verify(await handle.stat({ bigint: true }));
      yield* this.readRange(handle, start, Math.min(end, this.fileSize));
    } finally {
      await handle.close();
    }
  }

  async verifyPath(): Promise<void> {
    this.verify(await stat(this.sourceFile, { bigint: true }).catch(error => this.rethrowMissing(error)));
  }

  private verify(current: BigIntStats): void {
    if (current.dev !== this.identity.dev || current.ino !== this.identity.ino || current.size < this.identity.size) {
      throw new TranscriptChangedError(this.sourceFile);
    }
  }

  private rethrowMissing(error: unknown): never {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      throw new TranscriptChangedError(this.sourceFile, error);
    }
    throw error;
  }

  private async *readRange(handle: FileHandle, start: number, end: number): AsyncGenerator<Buffer> {
    let offset = start;
    while (offset < end) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, end - offset));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (bytesRead === 0) throw new TranscriptChangedError(this.sourceFile);
      offset += bytesRead;
      yield chunk.subarray(0, bytesRead);
    }
  }
}
