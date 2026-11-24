import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceSightings } from "#src/scan/source-sightings";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";
import { ScanPassFixture } from "../../fixtures/provider-scan-fixture.ts";

const transcript = ScanPassFixture.source({ sessionId: "chat", sourceFile: "/root/sessions/rollout-chat.jsonl" });
const located = { location: { root: "/root", path: "rollout-chat.jsonl", cwd: "/work" }, rootStreamId: "stream-under-root" };

test("with an installation ID the stream ID is the path of the location", async () => {
  const sightings = new SourceSightings(new InMemoryCollectorStorage());
  const sighting = await sightings.capture({ harness: "codex", root: "/root", installationId: "install" }, transcript, located, 120);
  assert.deepEqual(sighting.source, { harness: "codex", sessionId: "chat", streamId: "rollout-chat.jsonl", installationId: "install" });
  assert.deepEqual(sighting.observation, { location: located.location, observedEnd: 120 });
});

test("without an installation ID the stream ID is the root-based stream ID of the provider", async () => {
  const sightings = new SourceSightings(new InMemoryCollectorStorage());
  const sighting = await sightings.capture({ harness: "claude", root: "/root" }, transcript, located, 120);
  assert.deepEqual(sighting.source, { harness: "claude", sessionId: "chat", streamId: "stream-under-root" });
  assert.deepEqual(sighting.observation, { location: located.location, observedEnd: 120 });
});
