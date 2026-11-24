import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CollectorCommand } from "@tracerelic/collector/command";
import type { CollectorStorage, SessionView } from "@tracerelic/collector/storage";
import { ClaudeProjectFixture } from "./claude-project-fixture.ts";
import { InMemoryCollectorStorage } from "./in-memory-collector-storage.ts";

type Installation = "desktop" | "laptop";

interface NativeUsage {
  input_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens: number;
  iterations?: readonly object[];
}

export class ClaudeUsageScanFixture {
  readonly key = { harness: "claude", sessionId: "usage-history" } as const;
  readonly storage = new InMemoryCollectorStorage();
  readonly files = { desktop: "", laptop: "" };

  private constructor(readonly roots: Record<Installation, ClaudeProjectFixture>) {}

  static async create() {
    const roots = { desktop: await ClaudeProjectFixture.create(), laptop: await ClaudeProjectFixture.create() };
    const fixture = new ClaudeUsageScanFixture(roots);
    for (const id of ["desktop", "laptop"] as const) {
      const root = roots[id];
      fixture.files[id] = await root.write("project", fixture.key.sessionId, []);
      await writeFile(join(root.home, "collector.json"), JSON.stringify({ claudePath: root.home, codexPath: root.home, installationId: id }));
    }
    return fixture;
  }

  async close() {
    await Promise.all(Object.values(this.roots).map(root => root.close()));
  }

  report(second: number, usage: NativeUsage, options: {
    text?: string; final?: boolean; request?: string; uuid?: string;
  } = {}) {
    const request = options.request ?? "primary";
    return {
      sessionId: this.key.sessionId, timestamp: new Date(Date.UTC(2026, 1, 1, 12, 0, second)).toISOString(),
      type: "assistant", uuid: options.uuid, requestId: "request-" + request,
      message: { role: "assistant", id: "msg-" + request, stop_reason: options.final ? "tool_use" : null,
        content: options.text ? [{ type: "text", text: options.text }] :
          [{ type: "tool_use", id: "tool-read", name: "Read", input: { file_path: "notes.md" } }],
        usage,
      },
    };
  }

  append(id: Installation, ...rows: object[]) {
    return appendFile(this.files[id], rows.map(row => JSON.stringify(row) + "\n").join(""));
  }

  async scan(id: Installation, storage: CollectorStorage = this.storage): Promise<SessionView> {
    const config = join(this.roots[id].home, "collector.json");
    const views = await new CollectorCommand(storage).run(["scan", "--once", "--config", config, "--session", this.key.sessionId]);
    assert.equal(views.length, 1);
    const [view] = views;
    assert("usage" in view);
    assert.deepEqual(view.key, this.key);
    return view;
  }
}
