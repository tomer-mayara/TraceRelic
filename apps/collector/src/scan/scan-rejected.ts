import type { ByteRange, SessionView, StreamKey } from "../storage/collector-storage.ts";

export interface RejectedBatch {
  status: "rejected";
  source: StreamKey;
  byteRange: ByteRange;
}

export class ScanRejectedError extends Error {
  constructor(readonly sessions: readonly SessionView[], readonly rejections: readonly RejectedBatch[]) {
    super(rejections.map(({ source, byteRange }) =>
      `Storage returned invalid for ${source.streamId}, bytes ${byteRange.startOffset}..${byteRange.endOffset}`).join("\n"));
    this.name = "ScanRejectedError";
  }

  static batch(source: StreamKey, { startOffset, endOffset }: ByteRange): RejectedBatch {
    const { harness, sessionId, streamId, installationId } = source;
    return {
      status: "rejected",
      source: { harness, sessionId, streamId, ...(installationId !== undefined && { installationId }) },
      byteRange: { startOffset, endOffset },
    };
  }
}
