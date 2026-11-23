import { createHash } from "node:crypto";
import type { Batch, StreamKey } from "../collector-storage.ts";

export const collectorRequestBytes = 1024 * 1024;
export const batchPartBytes = collectorRequestBytes / 2;
export interface BatchPart { transfer: "part-v1"; upload: string; index: number; data: string }
export interface PackedBatch {
  transfer: "commit-v1"; source: StreamKey; expectedVersion: number; upload: string; base?: string; inline?: string; parts?: number;
  decodedBytes: number; decodedSha256: string;
}
type Copy = [number, number];
type Delta = (string | Copy)[];
const block = 1024;
const modulus = 65521;

/** The wire form of a batch. It can be a delta from the accepted parser state. A large batch goes in parts. */
export class PackedBatches {
  static digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
  static stateBytes(state?: string): Buffer { return Buffer.from(JSON.stringify(state ?? "")); }

  /** An immutable transcript record still has to fit a single ordinary request. Arrays of records can span parts. */
  static fitsWireRecords(batch: Batch): boolean {
    const lineBytes = new Map<number, number>();
    for (const message of batch.messages) {
      const length = Buffer.byteLength(JSON.stringify(message));
      const total = length + (message.sourceOrder === undefined ? 0 : lineBytes.get(message.sourceOrder) ?? 0);
      if (total > collectorRequestBytes) return false;
      if (message.sourceOrder !== undefined) lineBytes.set(message.sourceOrder, total);
    }
    return [...batch.usage, ...batch.claudeUsageReports ?? []].every(row => Buffer.byteLength(JSON.stringify(row)) <= collectorRequestBytes);
  }

  private static checksum(bytes: Buffer, offset: number) {
    let a = 0, b = 0;
    for (let i = offset; i < offset + block; i++) { a += bytes[i]; b += a; }
    return { a: a % modulus, b: b % modulus };
  }

  /** An rsync-style rolling checksum finds unchanged ranges anywhere in opaque versioned parser state.
   * SHA-256 verifies candidate blocks. The complete transfer and reconstructed write are verified separately. */
  private static deltaBytes(input: Buffer, base: Buffer): Buffer {
    const index = new Map<number, Map<string, number>>();
    for (let i = 0; i + block <= base.length; i += block) {
      const { a, b } = PackedBatches.checksum(base, i);
      const key = b * modulus + a;
      const offsets = index.get(key) ?? new Map<string, number>();
      offsets.set(PackedBatches.digest(base.subarray(i, i + block)), i);
      index.set(key, offsets);
    }
    const parts: Delta = [];
    let i = 0, first = 0, weak = input.length >= block ? PackedBatches.checksum(input, 0) : { a: 0, b: 0 };
    while (i + block <= input.length) {
      const matches = index.get(weak.b * modulus + weak.a);
      const offset = matches?.get(PackedBatches.digest(input.subarray(i, i + block)));
      if (offset !== undefined) {
        if (i > first) parts.push(input.toString("base64", first, i));
        let n = block;
        while (i + n < input.length && offset + n < base.length && input[i + n] === base[offset + n]) n++;
        parts.push([offset, n]);
        first = i += n;
        if (i + block <= input.length) weak = PackedBatches.checksum(input, i);
      } else {
        const old = input[i++];
        const added = input[i + block - 1] ?? 0;
        weak.a = (weak.a + added - old + modulus) % modulus;
        weak.b = (weak.b + weak.a - block * old) % modulus;
        if (weak.b < 0) weak.b += modulus;
      }
    }
    if (first < input.length) parts.push(input.toString("base64", first));
    return Buffer.from(JSON.stringify(parts));
  }

  static pack(batch: Batch, original: string, prior?: string) {
    const raw = Buffer.from(original);
    const base = PackedBatches.stateBytes(prior);
    const delta = base.length >= block ? PackedBatches.deltaBytes(raw, base) : undefined;
    // A batch can cite the accepted state in its checkpoint and comparison fields. Bound copy expansion on both sides.
    const compact = delta && delta.length < raw.length && raw.length <= base.length * 6 + delta.length;
    const bytes = compact ? delta : raw;
    const header: PackedBatch = { transfer: "commit-v1", source: batch.source, expectedVersion: batch.expectedVersion,
      upload: PackedBatches.digest(bytes), decodedBytes: raw.length, decodedSha256: PackedBatches.digest(raw), ...(compact && { base: PackedBatches.digest(base) }) };
    const inline = bytes.length <= batchPartBytes ? bytes.toString("base64") : undefined;
    return { bytes, header: inline && Buffer.byteLength(JSON.stringify({ ...header, inline })) <= collectorRequestBytes
      ? { ...header, inline } : { ...header, parts: Math.ceil(bytes.length / batchPartBytes) } };
  }

  static decodeBase64(value: string): Buffer {
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64") !== value) throw new TypeError("Invalid transfer bytes");
    return decoded;
  }

  static unpack(bytes: Buffer, header: PackedBatch, base?: Buffer): unknown {
    if (!base) return bytes.length === header.decodedBytes && PackedBatches.digest(bytes) === header.decodedSha256 ? JSON.parse(bytes.toString("utf8")) : null;
    if (header.decodedBytes > base.length * 6 + bytes.length) return null;
    const parts: unknown = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(parts)) throw new TypeError("Invalid batch delta");
    const ranges = parts.map((part: unknown) => {
      if (typeof part === "string") return PackedBatches.decodeBase64(part);
      if (!Array.isArray(part) || part.length !== 2 || !part.every(Number.isSafeInteger)) throw new TypeError("Invalid batch range");
      const [offset, length] = part;
      if (offset < 0 || length <= 0 || offset > base.length - length) throw new TypeError("Invalid batch range");
      return base.subarray(offset, offset + length);
    });
    if (ranges.reduce((total, span) => total + span.length, 0) !== header.decodedBytes) return null;
    const output = Buffer.concat(ranges, header.decodedBytes);
    return PackedBatches.digest(output) === header.decodedSha256 ? JSON.parse(output.toString("utf8")) : null;
  }
}
