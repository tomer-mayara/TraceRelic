import type { Batch, PresenceWrite, SourceScope, StreamKey } from "@tracerelic/collector/storage";
import { InMemoryCollectorStorage } from "./in-memory-collector-storage.ts";

/** Control the transport at the point where a write or its reply can be lost. */
export class PresenceConnection extends InMemoryCollectorStorage {
  offline = false;
  loseFirstUpload?: "request" | "reply";
  losePresenceReply = false;
  interruptPresence?: () => Promise<void>;

  private unavailable(): never {
    throw Object.assign(new Error("Disconnected"), { code: "ECONNRESET" });
  }

  override async readCheckpoint(source: StreamKey) {
    if (this.offline) this.unavailable();
    return super.readCheckpoint(source);
  }

  override async commit(batch: Batch) {
    const lose = this.loseFirstUpload;
    this.loseFirstUpload = undefined;
    if (lose === "request") this.unavailable();
    const result = await super.commit(batch);
    if (lose === "reply") {
      this.offline = true;
      this.unavailable();
    }
    return result;
  }

  override async listSources(scope: SourceScope) {
    if (this.offline) this.unavailable();
    return super.listSources(scope);
  }

  override async recordPresence(update: PresenceWrite) {
    if (this.interruptPresence) {
      const interrupt = this.interruptPresence;
      this.interruptPresence = undefined;
      await interrupt();
      return "conflict" as const;
    }
    const result = await super.recordPresence(update);
    if (this.losePresenceReply) {
      this.losePresenceReply = false;
      this.unavailable();
    }
    return result;
  }
}
