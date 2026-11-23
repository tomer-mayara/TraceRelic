import { createHash, type Hash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";

export class TranscriptChangedError extends Error {
  constructor(readonly sourceFile: string, cause?: unknown) {
    super("Transcript changed while reading " + sourceFile, { cause });
    this.name = "TranscriptChangedError";
  }
}

function rethrowMissing(sourceFile: string, error: unknown): never {
  if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
    throw new TranscriptChangedError(sourceFile, error);
  }
  throw error;
}

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

export class CapturedTranscriptFile {
  private readonly physicalSize: number;
  private logicalSize = 0;
  private finalNewline = 0;
  private seal = "";
  private revision = 0;
  private readonly beginning = { offset: 0, hash: createHash("sha256") };
  private readonly verified = new Map<number, Hash>([[0, this.beginning.hash]]);
  private latestBatch?: { offset: number; hash: Hash };

  private constructor(readonly sourceFile: string, private observed: BigIntStats) {
    this.physicalSize = Number(observed.size);
    this.checkSize(this.physicalSize);
  }

  get fileSize(): number { return this.logicalSize; }
  get statRevision(): number { return this.revision; }

  static async inspect<T>(sourceFile: string, inspect: (chunks: AsyncIterable<Buffer>) => Promise<T>) {
    const handle = await open(sourceFile, "r").catch(error => rethrowMissing(sourceFile, error));
    try {
      const file = new CapturedTranscriptFile(sourceFile, await handle.stat({ bigint: true }));
      const chunks = file.capture(handle);
      try {
        // Discovery can stop at a header. Keep hashing the very same stream through the fixed extent.
        const result = await inspect({ [Symbol.asyncIterator]: () => ({ next: () => chunks.next() }) });
        for await (const _chunk of chunks) { /* drain the bytes after the last discovery record */ }
        await file.verifyPath();
        return { file, result };
      } finally {
        await chunks.return(undefined);
      }
    } finally {
      await handle.close();
    }
  }

  /** A raw date query reads one fixed file range without retaining its contents or a descriptor. */
  static async *read(sourceFile: string): AsyncGenerator<Buffer> {
    const handle = await open(sourceFile, "r");
    try {
      const file = new CapturedTranscriptFile(sourceFile, await handle.stat({ bigint: true }));
      yield* file.readRange(handle, 0, Infinity);
    } finally {
      await handle.close();
    }
  }

  private async *capture(handle: FileHandle): AsyncGenerator<Buffer> {
    const hash = createHash("sha256");
    for await (const chunk of this.readRange(handle, 0, Infinity)) {
      const index = chunk.lastIndexOf(0x0a);
      if (index >= 0) this.finalNewline = this.logicalSize + index + 1;
      this.logicalSize += chunk.length;
      this.checkSize(this.logicalSize);
      hash.update(chunk);
      yield chunk;
    }
    this.seal = hash.copy().digest("hex");
    this.verified.set(this.logicalSize, hash);
  }

  private checkSize(size: number): void {
    if (!Number.isSafeInteger(size)) throw new RangeError("Transcript exceeds the supported byte range: " + this.sourceFile);
  }

  async *chunks(start: number, end: number): AsyncGenerator<Buffer> {
    const handle = await this.openChecked();
    try {
      yield* this.readRange(handle, start, Math.min(end, this.fileSize));
    } finally {
      await handle.close();
    }
  }

  async completeEnd(): Promise<number> {
    await this.verifyPath();
    return this.finalNewline;
  }

  async prefixDigests(offsets: readonly number[]): Promise<{ offset: number; prefixDigest: string }[]> {
    if (offsets.some(offset => !Number.isSafeInteger(offset) || offset < 0 || offset > this.fileSize)) {
      throw new RangeError("Expected a byte position within the captured transcript");
    }
    const missing = [...new Set(offsets)].filter(offset => !this.verified.has(offset)).sort((a, b) => a - b);
    if (missing.length) {
      const revision = this.revision;
      const { offset: start, hash } = this.hashBefore(missing[0]);
      const end = missing[missing.length - 1];
      const snapshots = await this.hashOffsets(this.chunks(start, end), start, hash, missing, end);
      await this.verifyPath(snapshots, revision);
      for (const [offset, snapshot] of snapshots) this.verified.set(offset, snapshot);
    } else await this.verifyPath();
    const result = offsets.map(offset => ({ offset, prefixDigest: this.hashBefore(offset).hash.digest("hex") }));
    // A caller can request many checkpoints over the lifetime of one capture. Only the cache is bounded.
    for (const offset of this.verified.keys()) {
      if (this.verified.size <= 64) break;
      if (offset !== 0 && offset !== this.fileSize) this.verified.delete(offset);
    }
    return result;
  }

  /** Read all requested snapshots in one pass, including when a compressed range must start at byte zero. */
  private async hashOffsets(chunks: AsyncIterable<Buffer>, position: number, hash: Hash, offsets: number[], end: number) {
    const snapshots = new Map<number, Hash>();
    let next = 0;
    if (offsets[0] === position) snapshots.set(offsets[next++], hash.copy());
    for await (const chunk of chunks) {
      const following = position + chunk.length;
      let start = 0;
      while (next < offsets.length && offsets[next] <= following) {
        const cut = offsets[next] - position;
        hash.update(chunk.subarray(start, cut));
        snapshots.set(offsets[next++], hash.copy());
        start = cut;
      }
      hash.update(chunk.subarray(start));
      position = following;
    }
    if (position !== end || next !== offsets.length) throw new TranscriptChangedError(this.sourceFile);
    return snapshots;
  }

  async startBatch(offset: number): Promise<{ revision: number; hash: Hash }> {
    const revision = this.revision;
    const { offset: start, hash } = this.hashBefore(offset);
    if (start < offset) for await (const chunk of this.chunks(start, offset)) hash.update(chunk);
    return { revision, hash };
  }

  async finishBatch(offset: number, hash: Hash, revision: number): Promise<string> {
    await this.verifyPath(new Map([[offset, hash]]), revision);
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

  private async openChecked(): Promise<FileHandle> {
    const handle = await open(this.sourceFile, "r").catch(error => rethrowMissing(this.sourceFile, error));
    try {
      this.checkStat(this.observed, await handle.stat({ bigint: true }));
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async verifyPath(provisional?: Map<number, Hash>, revision = this.revision): Promise<void> {
    const current = await this.pathStat();
    this.checkStat(this.observed, current);
    if (unchanged(this.observed, current) && revision === this.revision) return;
    // Size growth can include an in-place rewrite. Prove the whole original extent and the actual bytes
    // accumulated by a reader that overlapped a change before publishing any of its provisional work.
    const offsets = [...new Set([...(provisional?.keys() ?? []), this.fileSize])].sort((a, b) => a - b);
    for (let attempt = 0; attempt < 2; attempt++) {
      const handle = await this.openChecked();
      try {
        const before = await handle.stat({ bigint: true });
        const hashes = await this.hashOffsets(this.readRange(handle, 0, Infinity), 0, createHash("sha256"), offsets, this.fileSize);
        const after = await this.pathStat();
        this.checkStat(before, after);
        const digest = (offset: number) => hashes.get(offset)?.copy().digest("hex");
        if (digest(this.fileSize) !== this.seal) throw new TranscriptChangedError(this.sourceFile);
        for (const [offset, hash] of provisional ?? []) {
          if (digest(offset) !== hash.copy().digest("hex")) throw new TranscriptChangedError(this.sourceFile);
        }
        if (unchanged(before, after)) {
          this.checkStat(this.observed, after);
          if (!unchanged(this.observed, after)) this.revision++;
          this.observed = after;
          return;
        }
      } finally {
        await handle.close();
      }
    }
    throw new TranscriptChangedError(this.sourceFile);
  }

  private pathStat() {
    return stat(this.sourceFile, { bigint: true }).catch(error => rethrowMissing(this.sourceFile, error));
  }

  private checkStat(before: BigIntStats, after: BigIntStats): void {
    if (before.dev !== after.dev || before.ino !== after.ino || after.size < before.size
      || (after.size === before.size && !unchanged(before, after))) throw new TranscriptChangedError(this.sourceFile);
  }

  private async *readRange(handle: FileHandle, start: number, end: number): AsyncGenerator<Buffer> {
    if (start >= end) return;
    if (!this.sourceFile.endsWith(".jsonl.zst")) {
      yield* this.rawRange(handle, start, Math.min(end, this.physicalSize));
      return;
    }
    const input = Readable.from(this.rawRange(handle, 0, this.physicalSize), { objectMode: false });
    const decoder = createZstdDecompress();
    const observed = this.observed;
    const decoded = pipeline(input, decoder);
    // The iterator below propagates errors. The pipeline may settle while the caller holds a batch.
    void decoded.catch(() => {});
    try {
      let offset = 0;
      for await (const chunk of decoder as AsyncIterable<Buffer>) {
        const next = offset + chunk.length;
        if (next > start) yield chunk.subarray(Math.max(0, start - offset), Math.min(chunk.length, end - offset));
        if (next >= end) break;
        offset = next;
      }
    } catch (error) {
      if (!unchanged(observed, await this.pathStat())) throw new TranscriptChangedError(this.sourceFile, error);
      throw error;
    } finally {
      input.destroy();
      decoder.destroy();
      await decoded.catch(() => {});
    }
  }

  private async *rawRange(handle: FileHandle, start: number, end: number): AsyncGenerator<Buffer> {
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
