import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { CollectorCommand } from "@tracerelic/collector/command";
import type { Batch, CollectorStorage } from "../../src/storage/collector-storage.ts";
import { CodexRolloutFixture as Rollout } from "./codex-rollout-fixture.ts";
import { InMemoryCollectorStorage } from "./in-memory-collector-storage.ts";

export class RewriteScanFixture {
  readonly storage = new InMemoryCollectorStorage();
  readonly source;
  readonly header = Rollout.header("s");
  file: string;

  private constructor(readonly root: Rollout, file: string, private readonly config: string) {
    this.file = file;
    this.source = { harness: "codex", sessionId: "s", streamId: basename(file), installationId: "desktop" } as const;
  }

  static async create() {
    const root = await Rollout.create();
    const file = await root.write([Rollout.header("s")]);
    const config = join(root.home, "collector.json");
    await writeFile(config, JSON.stringify({ codexPath: root.home, installationId: "desktop" }));
    return new RewriteScanFixture(root, file, config);
  }

  close() {
    return this.root.close();
  }

  call(id: string, tokens: number) {
    return { timestamp: this.header.timestamp, type: "event_msg", payload: {
      type: "token_count", call_id: id, info: { last_token_usage: { input_tokens: tokens, output_tokens: 0 } },
    } };
  }

  async write(rows: readonly object[], endOffset?: number) {
    const records = [this.header, ...rows].map(row => JSON.stringify(row)).join("\n");
    const size = Buffer.byteLength(records) + 1;
    const padding = endOffset === undefined ? 0 : endOffset - size;
    assert(padding >= 0, `Transcript needs ${size} bytes`);
    await writeFile(this.file, records + " ".repeat(padding) + "\n");
  }

  append(row: object) {
    return appendFile(this.file, JSON.stringify(row) + "\n");
  }

  async scan(storage: CollectorStorage = this.storage) {
    const views = await this.scanAll(storage);
    assert.equal(views.length, 1);
    const [view] = views;
    assert("usage" in view);
    return view;
  }

  scanAll(storage: CollectorStorage = this.storage) {
    return new CollectorCommand(storage).run(["scan", "--once", "--config", this.config]);
  }

  /** Capture the old scanner's actual append and let the test choose when storage receives it. */
  async holdAppend(row: object): Promise<Batch> {
    await this.append(row);
    let held: Batch | undefined;
    const delayed = new Error("Batch held for delivery");
    await assert.rejects(this.scan({
      readCheckpoint: key => this.storage.readCheckpoint(key),
      readSession: key => this.storage.readSession(key),
      commit: async batch => {
        held = batch;
        throw delayed;
      },
    }), error => error === delayed);
    assert(held);
    return held;
  }
}
