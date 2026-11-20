import type { ByteRange, SourceScope, StreamKey } from "../storage/collector-storage.ts";

type PendingTarget = { source: StreamKey; scope?: never; byteRange?: ByteRange; reason: "storage-unavailable" | "version-conflict" }
  | { scope: SourceScope; source?: never; byteRange?: never; reason: "storage-unavailable" };

export type PendingScan = PendingTarget & {
  status: "pending";
  retryAt: string;
};

function target(reason: PendingScan["reason"], key: StreamKey | SourceScope, byteRange?: ByteRange): PendingTarget {
  const { harness, installationId } = key;
  const installation = installationId === undefined ? {} : { installationId };
  if ("root" in key) {
    const { root, projectPaths, sessionIds } = key;
    return { reason: "storage-unavailable", scope: { harness, root, ...installation, ...(sessionIds && { sessionIds: [...sessionIds] }),
      ...(projectPaths && { projectPaths: [...projectPaths] }) } };
  }
  const { sessionId, streamId } = key;
  return { reason, source: { harness, sessionId, streamId, ...installation },
    ...(byteRange && { byteRange: { startOffset: byteRange.startOffset, endOffset: byteRange.endOffset } }) };
}

export class ScanPendingError extends Error {
  readonly pending: PendingScan;

  constructor(reason: "storage-unavailable", key: StreamKey | SourceScope);
  constructor(reason: PendingScan["reason"], key: StreamKey, byteRange?: ByteRange);
  constructor(reason: PendingScan["reason"], key: StreamKey | SourceScope, byteRange?: ByteRange) {
    const problem = reason === "version-conflict" ? "Storage returned conflict" : "Storage connection unavailable";
    const bytes = byteRange ? `, bytes ${byteRange.startOffset}..${byteRange.endOffset}` : "";
    super(`${problem} for ${"root" in key ? key.root : key.streamId}${bytes}`);
    this.name = "ScanPendingError";
    this.pending = {
      status: "pending",
      ...target(reason, key, byteRange),
      retryAt: new Date(Date.now() + 1000).toISOString(),
    };
  }
}
