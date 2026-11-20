import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CollectorCommand } from "@tracerelic/collector/command";
import type { Batch, CollectorStorage, MissingSource } from "../../src/storage/collector-storage.ts";
import { ClaudeProjectFixture } from "./claude-project-fixture.ts";
import { InMemoryCollectorStorage } from "./in-memory-collector-storage.ts";
import { RewriteScanFixture } from "./rewrite-scan-fixture.ts";

export class RejectSecondBatch extends InMemoryCollectorStorage {
  override async commit(batch: Batch) {
    return batch.expectedOffset > 0 ? "invalid" as const : super.commit(batch);
  }
}

export class MissingSourceFixture {
  readonly reports: MissingSource[] = [];
  readonly args: string[];

  private constructor(readonly transcript: RewriteScanFixture) {
    this.args = ["scan", "--once", "--config", join(transcript.root.home, "collector.json")];
  }

  static async create() { return new MissingSourceFixture(await RewriteScanFixture.create()); }
  close() { return this.transcript.close(); }

  async useClaude() {
    const { file, root } = this.transcript;
    await rm(file);
    const claude = new ClaudeProjectFixture(join(root.home, "claude"));
    const config = join(root.home, "claude.json");
    await writeFile(config, JSON.stringify({ codexPath: root.home, claudePath: claude.home, installationId: "desktop" }));
    return { claude, args: ["scan", "--once", "--config", config] };
  }

  async scan(args: string[] = this.args, storage: CollectorStorage = this.transcript.storage) {
    const result = await new CollectorCommand(storage, undefined, report => this.reports.push(report)).run(args);
    return result.map(view => { assert("usage" in view); return view; });
  }

  async acknowledge(tokens: number, accepted: number, end: number) {
    const { transcript } = this;
    await transcript.write([transcript.call("known", tokens)], accepted);
    const [view] = await this.scan();
    assert.equal(view?.observedTotalTokens, tokens);
    assert.equal(view.coverage, "reported");
    const before = await transcript.storage.readCheckpoint(transcript.source);
    assert.equal(before.checkpoint?.offset, accepted);
    if (end > accepted) {
      const suffix = "{}".padEnd(end - accepted - 1) + "\n";
      await appendFile(transcript.file, suffix);
      assert.equal((await stat(transcript.file)).size, end);
      // Storage can acknowledge observing a complete suffix before it accepts the records in it.
      assert.equal(await transcript.storage.recordPresence({
        source: transcript.source, expectedVersion: before.version, expectedOffset: accepted, presence: "present", observedEnd: end,
        observedPrefixDigest: createHash("sha256").update(await readFile(transcript.file)).digest("hex"),
        location: { root: transcript.root.home, path: transcript.source.streamId },
      }), "committed");
    }
    return transcript.storage.readCheckpoint(transcript.source);
  }

  missing(acceptedOffset: number, observedEnd: number): MissingSource {
    return { status: "missing", source: this.transcript.source, acceptedOffset, observedEnd };
  }
}
