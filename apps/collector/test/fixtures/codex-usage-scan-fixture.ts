import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { CollectorCommand } from "@tracerelic/collector/command";
import type { CollectorStorage, SessionView } from "@tracerelic/collector/storage";
import { CodexRolloutFixture as Rollout } from "./codex-rollout-fixture.ts";
import { InMemoryCollectorStorage } from "./in-memory-collector-storage.ts";

type Installation = "desktop" | "laptop";

export class CodexUsageScanFixture {
  readonly key = { harness: "codex", sessionId: "usage-history" } as const;
  readonly storage = new InMemoryCollectorStorage();
  private readonly files = { desktop: "", laptop: "" };

  private constructor(private readonly roots: Record<Installation, Rollout>) {}

  static async create(): Promise<CodexUsageScanFixture> {
    const roots = { desktop: await Rollout.create(), laptop: await Rollout.create() };
    const fixture = new CodexUsageScanFixture(roots);
    for (const id of ["desktop", "laptop"] as const) {
      const header = Rollout.header(fixture.key.sessionId);
      fixture.files[id] = await roots[id].write([{ ...header, payload: { ...header.payload, timestamp: header.timestamp } }]);
      await writeFile(join(roots[id].home, "collector.json"), JSON.stringify({ codexPath: roots[id].home, installationId: id }));
    }
    return fixture;
  }

  async close() {
    await Promise.all(Object.values(this.roots).map(root => root.close()));
  }

  checkpoint(id: Installation) {
    return this.storage.readCheckpoint({ ...this.key, installationId: id, streamId: basename(this.files[id]) });
  }

  damage(id: Installation) {
    return appendFile(this.files[id], "{damaged\n");
  }

  append(id: Installation, ...rows: object[]) {
    return appendFile(this.files[id], rows.map(row => JSON.stringify(row) + "\n").join(""));
  }

  async scan(id: Installation, storage: CollectorStorage = this.storage): Promise<SessionView> {
    const config = join(this.roots[id].home, "collector.json");
    const views = await new CollectorCommand(storage).run(["scan", "--once", "--config", config]);
    assert.equal(views.length, 1);
    const [view] = views;
    assert("usage" in view);
    assert.deepEqual(view.key, this.key);
    return view;
  }

  async report(id: Installation, second: number, total?: number, last?: number, requestId?: string) {
    const at = new Date(Date.UTC(2026, 1, 1, 12, 0, second)).toISOString();
    const counts = (tokens: number) => ({
      input_tokens: tokens - Math.floor(tokens / 5), output_tokens: Math.floor(tokens / 5), total_tokens: tokens,
    });
    const record = { timestamp: at, type: "event_msg", payload: {
      type: "token_count", request_id: requestId, info: {
        total_token_usage: total === undefined ? undefined : counts(total),
        last_token_usage: last === undefined ? undefined : counts(last),
      },
    } };
    const records = requestId ? [
      { timestamp: at, type: "turn_context", payload: { turn_id: "turn-" + requestId, model: "fixture-model" } }, record,
    ] : [record];
    await appendFile(this.files[id], records.map(row => JSON.stringify(row) + "\n").join(""));
  }
}
