import type { Batch, CollectorStorage, CommitResult } from "@tracerelic/collector/storage";
import { CollectorApi, type CommitMetric } from "@tracerelic/api";

/** Record calls at the storage port while exercising the real HTTP server. */
export class HttpStorageProbe {
  readonly scope = { workspaceId: "team", installationId: "desktop" };
  readonly source = { harness: "codex", sessionId: "chat", streamId: "rollout" } as const;
  readonly batch: Batch = { source: this.source, expectedVersion: 0, expectedOffset: 0,
    checkpoint: { offset: 10, parserState: "{}" }, messages: [
      { id: "msg", at: "2026-01-01T00:00:00Z", role: "user", text: "Private chat" },
    ], usage: [] };
  readonly metrics: CommitMetric[] = [];
  readonly lookups: string[] = [];
  readonly writes: Batch[] = [];
  outcome: CommitResult | Error = "committed";
  private base = "";
  private readonly storage: CollectorStorage = {
    listSources: async () => [], readSession: async () => null,
    readCheckpoint: async () => ({ version: 0, checkpoint: null }), recordPresence: async () => "committed",
    commit: async batch => {
      this.writes.push(batch);
      if (this.outcome instanceof Error) throw this.outcome;
      return this.outcome;
    },
  };
  private readonly api: CollectorApi;

  constructor(onCommit: (event: CommitMetric) => void = event => this.metrics.push(event)) {
    this.api = new CollectorApi({
      credentials: { verify: authorization => authorization === "Bearer fixture-token" ? this.scope : null },
      storageForWorkspace: workspace => { this.lookups.push(workspace); return this.storage; }, onCommit,
    });
  }

  async start(): Promise<void> { this.base = await this.api.listen(); }
  close(): Promise<void> { return this.api.close(); }

  post(path: string, body: string | undefined, authorization: string | null = "Bearer fixture-token", type = "application/json") {
    return fetch(this.base + "/v1/collector/" + path, { method: "POST", body,
      headers: { "content-type": type, ...(authorization !== null && { authorization }) } });
  }
}
