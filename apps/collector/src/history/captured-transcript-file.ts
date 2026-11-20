import { createHash, type Hash } from "node:crypto";
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
  private readonly beginning = { offset: 0, hash: createHash("sha256") };
  private readonly verified = new Map<number, Hash>([[0, this.beginning.hash]]);
  private latestBatch?: { offset: number; hash: Hash };
  private finalNewline?: Promise<number>;

  private constructor(readonly sourceFile: string, private observed: BigIntStats) {
    this.fileSize = Number(observed.size);
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
    const handle = await this.openVerified();
    try {
      yield* this.readRange(handle, start, Math.min(end, this.fileSize));
    } finally {
      await handle.close();
    }
  }

  async completeEnd(): Promise<number> {
    this.finalNewline ??= this.findLastNewline();
    const offset = await this.finalNewline;
    await this.verifyPath();
    return offset;
  }

  private async findLastNewline(): Promise<number> {
    const handle = await this.openVerified();
    try {
      let end = this.fileSize;
      // Most captures end at a newline. Read back in bounded chunks only for an unfinished suffix.
      let size = 1;
      while (end > 0) {
        const start = Math.max(0, end - size);
        let position = start;
        let last = 0;
        for await (const chunk of this.readRange(handle, start, end)) {
          const index = chunk.lastIndexOf(0x0a);
          if (index >= 0) last = position + index + 1;
          position += chunk.length;
        }
        if (last) return last;
        end = start;
        size = 64 * 1024;
      }
      return 0;
    } finally {
      await handle.close();
    }
  }

  async prefixDigests(offsets: readonly number[]): Promise<{ offset: number; prefixDigest: string }[]> {
    if (offsets.some(offset => !Number.isSafeInteger(offset) || offset < 0 || offset > this.fileSize)) {
      throw new RangeError("Expected a byte position within the captured transcript");
    }
    const missing = [...new Set(offsets)].filter(offset => !this.verified.has(offset)).sort((a, b) => a - b);
    if (missing.length) {
      const { offset: start, hash } = this.hashBefore(missing[0]);
      let position = start;
      const handle = await this.openVerified();
      try {
        const snapshots = new Map<number, Hash>();
        for (const offset of missing) {
          for await (const chunk of this.readRange(handle, position, offset)) hash.update(chunk);
          snapshots.set(offset, hash.copy());
          position = offset;
        }
        await this.verifyPath();
        for (const [offset, snapshot] of snapshots) this.verified.set(offset, snapshot);
      } finally {
        await handle.close();
      }
    } else await this.verifyPath();
    return offsets.map(offset => ({ offset, prefixDigest: this.hashBefore(offset).hash.digest("hex") }));
  }

  async startBatch(offset: number): Promise<Hash> {
    const { offset: start, hash } = this.hashBefore(offset);
    if (start < offset) {
      for await (const chunk of this.chunks(start, offset)) hash.update(chunk);
    }
    return hash;
  }

  finishBatch(offset: number, hash: Hash): string {
    // Another reader can start at this boundary while the current reader is suspended.
    this.latestBatch = { offset, hash: hash.copy() };
    return hash.copy().digest("hex");
  }

  private hashBefore(end: number): { offset: number; hash: Hash } {
    const exact = this.verified.get(end);
    if (exact) return { offset: end, hash: exact.copy() };
    let closest = this.latestBatch && this.latestBatch.offset <= end ? this.latestBatch : this.beginning;
    for (const [offset, hash] of this.verified) {
      if (offset <= end && offset > closest.offset) closest = { offset, hash };
    }
    return { offset: closest.offset, hash: closest.hash.copy() };
  }

  private async openVerified(): Promise<FileHandle> {
    const handle = await open(this.sourceFile, "r").catch(error => this.rethrowMissing(error));
    try {
      this.verify(await handle.stat({ bigint: true }));
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async verifyPath(): Promise<void> {
    this.verify(await stat(this.sourceFile, { bigint: true }).catch(error => this.rethrowMissing(error)));
  }

  private verify(current: BigIntStats): void {
    const saved = this.observed;
    const touched = current.mtimeNs !== saved.mtimeNs || current.ctimeNs !== saved.ctimeNs;
    if (current.dev !== saved.dev || current.ino !== saved.ino || current.size < saved.size || (current.size === saved.size && touched)) {
      throw new TranscriptChangedError(this.sourceFile);
    }
    this.observed = current;
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
