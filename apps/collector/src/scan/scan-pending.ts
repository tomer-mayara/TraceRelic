import type { ByteRange, StreamKey } from "../storage/collector-storage.ts";

export interface PendingScan {
  status: "pending";
  reason: "storage-unavailable" | "version-conflict";
  source: StreamKey;
  byteRange?: ByteRange;
  retryAt: string;
}

export class ScanPendingError extends Error {
  readonly pending: PendingScan;

  constructor(reason: PendingScan["reason"], source: StreamKey, byteRange?: ByteRange) {
    const { harness, sessionId, streamId, installationId } = source;
    const problem = reason === "version-conflict" ? "Storage returned conflict" : "Storage connection unavailable";
    const bytes = byteRange ? `, bytes ${byteRange.startOffset}..${byteRange.endOffset}` : "";
    super(`${problem} for ${streamId}${bytes}`);
    this.name = "ScanPendingError";
    this.pending = {
      status: "pending", reason,
      source: { harness, sessionId, streamId, ...(installationId !== undefined && { installationId }) },
      ...(byteRange && { byteRange: { startOffset: byteRange.startOffset, endOffset: byteRange.endOffset } }),
      retryAt: new Date(Date.now() + 1000).toISOString(),
    };
  }
}
