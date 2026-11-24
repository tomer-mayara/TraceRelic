import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Batch, CollectorStorage, PresenceWrite, StreamKey } from "@tracerelic/collector/storage";
import { batch, codexParserState, observation } from "./collector-storage-fixture.ts";
import { CodexRolloutFixture as Rollout } from "./codex-rollout-fixture.ts";
import { ConfiguredCollector } from "./configured-collector.ts";
import { InMemoryCollectorStorage } from "./in-memory-collector-storage.ts";

export class CodexIdentityRepairFixture {
  private constructor(readonly root: Rollout, readonly storage: CollectorStorage, readonly path: string) {}
  static async create(storage: CollectorStorage = new InMemoryCollectorStorage()) {
    const root = await Rollout.create();
    const at = "2026-02-01T12:00:00Z";
    const path = await root.write([Rollout.header("B"), Rollout.message(at, "belongs to B")]);
    return new this(root, storage, path);
  }
  key(sessionId: string): StreamKey {
    return { harness: "codex", sessionId, streamId: basename(this.path), installationId: "desktop" };
  }
  async legacy(options: { digest?: "wrong" | "absent"; usage?: boolean; wrongText?: boolean; emptyState?: boolean } = {}): Promise<Batch> {
    const bytes = await readFile(this.path);
    const source = this.key("A");
    const original = batch(0, 0, { source, sourceObservation: { location: { root: this.root.home, path: source.streamId }, observedEnd: bytes.length },
      checkpoint: { parserState: options.emptyState ? "{}" : codexParserState(2), offset: bytes.length, ...(options.digest !== "absent" && {
        prefixDigest: options.digest === "wrong" ? "a".repeat(64) : createHash("sha256").update(bytes).digest("hex") }) },
      messages: [{ id: "old-id", role: "user", at: "2026-02-01T12:00:00Z", text: options.wrongText ? "uncertain" : "belongs to B", sourceOrder: 2, blockIndex: 0 }],
      usage: options.usage ? [observation(10, 0)] : [] });
    assert.equal(await this.storage.commit(original), "committed");
    const other = { ...source, streamId: "independent" };
    assert.equal(await this.storage.commit(batch(1, 0, { source: other, messages: [{ id: "keep", role: "user", text: "belongs to A",
      at: "2026-02-01T12:00:00Z", sourceOrder: 2, blockIndex: 0 }] })), "committed");
    return original;
  }
  scan(sessionIds?: string[]) {
    return ConfiguredCollector.from({ codexPath: this.root.home, installationId: "desktop" }, this.storage).scanOnce({ sessionIds });
  }
  async proof(): Promise<PresenceWrite> {
    const source = this.key("A");
    const other = this.key("B");
    const [{ version, checkpoint: old }, { version: expectedPeerVersion, checkpoint: peer }] =
      await Promise.all([this.storage.readCheckpoint(source), this.storage.readCheckpoint(other)]);
    assert(old?.prefixDigest && peer?.prefixDigest);
    return { source, expectedVersion: version, expectedOffset: old.offset, observedEnd: old.offset, presence: "present",
      location: { root: this.root.home, path: source.streamId }, codexIdentity: {
        status: "verified", headerEnd: Buffer.byteLength(JSON.stringify(Rollout.header("B")) + "\n"), peerSessionId: "B", peerStreamId: other.streamId,
        expectedPeerVersion, accepted: { offset: old.offset, prefixDigest: old.prefixDigest }, peer: { offset: peer.offset, prefixDigest: peer.prefixDigest },
      } };
  }
  async texts(sessionId: string) { return (await this.storage.readSession(this.key(sessionId)))?.messages.map(row => row.text); }
}
