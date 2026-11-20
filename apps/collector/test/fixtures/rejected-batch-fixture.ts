import assert from "node:assert/strict";
import { appendFile, stat, truncate, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { CollectorCommand } from "@tracerelic/collector/command";
import { ClaudeProjectFixture } from "./claude-project-fixture.ts";
import { CodexRolloutFixture as Rollout } from "./codex-rollout-fixture.ts";
import { CodexUsageFixture as Usage } from "./codex-usage-fixture.ts";
import { InMemoryCollectorStorage } from "./in-memory-collector-storage.ts";

export class RejectedBatchFixture {
  readonly storage = new InMemoryCollectorStorage();
  readonly a;
  readonly b = { harness: "claude", sessionId: "b", streamId: "projects/project/b.jsonl", installationId: "desktop" } as const;
  readonly changedText = "Changed private text";
  readonly args: string[];

  private constructor(private readonly root: Rollout, private readonly file: string, private readonly claude: ClaudeProjectFixture) {
    this.a = { harness: "codex", sessionId: "a", streamId: basename(file), installationId: "desktop" } as const;
    this.args = ["scan", "--once", "--config", join(root.home, "collector.json")];
  }

  static async create() {
    const root = await Rollout.create();
    const claude = new ClaudeProjectFixture(join(root.home, "claude"));
    const file = await root.write([Rollout.header("a")]);
    await writeFile(join(root.home, "collector.json"), JSON.stringify({
      codexPath: root.home, claudePath: claude.home, installationId: "desktop",
    }));
    return new RejectedBatchFixture(root, file, claude);
  }

  close() { return this.root.close(); }

  scan() { return new CollectorCommand(this.storage).run(this.args); }

  private async append(text: string, id: string, branch: string, tokens: number) {
    const message = Rollout.message(Usage.at, text);
    const rows = [
      { ...message, payload: { ...message.payload, id, branch: "accepted" } },
      Usage.record("session_meta", { id: this.a.sessionId, branch }),
      Usage.report(undefined, Usage.counts(tokens, 0), { call_id: branch }),
    ];
    await appendFile(this.file, rows.map(row => JSON.stringify(row) + "\n").join(""));
  }

  async prepare(text: string, tokens: number) {
    await this.append(text, "item", "accepted", 8);
    await this.scan();
    const original = await this.storage.readSession(this.a);
    const checkpoint = await this.storage.readCheckpoint(this.a);
    const startOffset = (await stat(this.file)).size;
    assert(original && checkpoint.checkpoint?.offset === startOffset);
    assert.deepEqual(original.messages.map(row => row.text), [text]);
    assert.equal(original.observedTotalTokens, 8);
    assert.equal(original.metadata.branch, "accepted");
    await this.append(this.changedText, "item", "later", 7);
    const endOffset = (await stat(this.file)).size;
    const reply = ClaudeProjectFixture.assistant(this.b.sessionId, Usage.at, "Private healthy reply");
    reply.message.usage = { input_tokens: tokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    await this.claude.write("project", this.b.sessionId, [reply]);
    return { original, checkpoint, byteRange: { startOffset, endOffset } };
  }

  async repair(startOffset: number) {
    await truncate(this.file, startOffset);
    await this.append(this.changedText, "second-item", "later", 7);
    return (await stat(this.file)).size;
  }
}
