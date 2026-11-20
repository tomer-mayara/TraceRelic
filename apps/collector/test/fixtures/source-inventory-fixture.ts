import type { PresenceWrite, SourceLocation, SourceScope, StreamKey } from "../../src/storage/collector-storage.ts";
import { batch, observation } from "./collector-storage-fixture.ts";

export const inventorySource: StreamKey = {
  harness: "codex", sessionId: "session", streamId: "rollout-session.jsonl", installationId: "desktop",
};
export const inventoryLocation: SourceLocation = { root: "/home/codex", path: inventorySource.streamId, cwd: "/work/project" };
export const inventoryScope: SourceScope = { harness: "codex", installationId: "desktop", root: inventoryLocation.root };

export function measuredSource(end = 420) {
  return batch(0, 0, { source: inventorySource, sourceObservation: { location: inventoryLocation, observedEnd: end },
    checkpoint: { offset: 420, parserState: "prior" }, usage: [observation(65, 5)] });
}

export function presence(expectedVersion: number, status: PresenceWrite["presence"], observedEnd = 420): PresenceWrite {
  return { source: inventorySource, expectedVersion, expectedOffset: 420, location: inventoryLocation, observedEnd, presence: status };
}
