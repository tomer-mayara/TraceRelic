import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CollectorCommand } from "@tracerelic/collector/command";
import type { StreamKey } from "../../src/storage/collector-storage.ts";
import { ClaudeProjectFixture } from "./claude-project-fixture.ts";
import { InMemoryCollectorStorage } from "./in-memory-collector-storage.ts";

export type ChildKind = "fork" | "subagent";
type Site = "parent" | "child";

interface NativeReport {
  sessionId: string;
  uuid: string;
  requestId?: string;
  messageId: string;
  text: string;
  tokens: number;
  provisional?: boolean;
  timestamp?: string;
}

function call({ sessionId, uuid, requestId, messageId, text, tokens, provisional, timestamp = "2026-02-01T12:01:00Z" }: NativeReport) {
  return {
    sessionId, uuid, requestId, timestamp, type: "assistant",
    message: { id: messageId, role: "assistant", content: [{ type: "text", text }], stop_reason: provisional ? null : "end_turn",
      usage: { input_tokens: tokens - 5, output_tokens: 5 } },
  };
}

export class ClaudeForkScanFixture {
  readonly storage = new InMemoryCollectorStorage();
  readonly parent = { harness: "claude", sessionId: "parent", installationId: "desktop", streamId: "projects/project/parent.jsonl" } as const;
  readonly child: StreamKey;

  private constructor(readonly roots: Record<Site, ClaudeProjectFixture>, readonly kind: ChildKind) {
    this.child = this.childSource("helper");
  }

  childSource(agent: string): StreamKey {
    return {
      harness: "claude", installationId: "laptop",
      sessionId: this.kind === "fork" ? "forked" : "parent/subagents/" + agent,
      streamId: this.kind === "fork" ? "projects/project/forked.jsonl" : "projects/project/parent/subagents/agent-" + agent + ".jsonl",
    };
  }

  static async create(kind: ChildKind) {
    const roots = { parent: await ClaudeProjectFixture.create(), child: await ClaudeProjectFixture.create() };
    const fixture = new ClaudeForkScanFixture(roots, kind);
    for (const site of ["parent", "child"] as const) {
      await writeFile(join(roots[site].home, "collector.json"), JSON.stringify({
        claudePath: roots[site].home, codexPath: roots[site].home, installationId: fixture[site].installationId,
      }));
    }
    return fixture;
  }

  async close() { await Promise.all(Object.values(this.roots).map(root => root.close())); }

  writeParent(tokens = 100, options: { provisional?: boolean } = {}) {
    return this.roots.parent.write("project", "parent", [call({ sessionId: "parent", uuid: "original-row",
      requestId: "parent-request", messageId: "parent-message", text: "Inherited answer", tokens, ...options })]);
  }

  async writeCopy(tokens = 100, options: { originalUuid?: string; agent?: string; withPrompt?: boolean; provisional?: boolean; omitRequest?: boolean } = {}) {
    const { originalUuid = "original-row", agent = "helper", withPrompt = false } = options;
    const evidence = { messageId: "parent-message", text: "Inherited answer", tokens, provisional: options.provisional };
    const row = this.kind === "fork"
      ? { ...call({ ...evidence, sessionId: "forked", uuid: "copied-row",
        requestId: options.omitRequest ? undefined : "remapped-request", timestamp: "2026-02-01T12:02:00Z" }),
        forkedFrom: { sessionId: "parent", messageUuid: originalUuid } }
      : call({ ...evidence, sessionId: "parent", uuid: "original-row", requestId: "parent-request" });
    const name = this.kind === "fork" ? "forked" : "parent/subagents/agent-" + agent;
    const prefix = withPrompt ? [{
      ...ClaudeProjectFixture.user(row.sessionId, "2026-02-01T12:00:00Z", "Review café"), uuid: "prompt-row",
    }] : [];
    await this.roots.child.write("project", name, [...prefix, row]);
    const startOffset = Buffer.byteLength(prefix.map(prompt => JSON.stringify(prompt) + "\n").join(""));
    return { startOffset, endOffset: startOffset + Buffer.byteLength(JSON.stringify(row) + "\n") };
  }

  async appendOwn(tokens = 25, messageId = "child-message", agent = "helper") {
    const source = this.childSource(agent);
    const report = { requestId: "child-request-" + agent, messageId, text: "Child answer", tokens, timestamp: "2026-02-01T12:03:00Z" };
    const row = this.kind === "fork" ? call({ ...report, sessionId: "forked", uuid: "own-row" })
      : { ...call({ ...report, sessionId: "parent", uuid: "own-row-" + agent }), isSidechain: true, agentId: agent };
    await appendFile(join(this.roots.child.home, source.streamId), JSON.stringify(row) + "\n");
  }

  async scan(site: Site) {
    await new CollectorCommand(this.storage).run(["scan", "--once", "--config", join(this.roots[site].home, "collector.json")]);
  }

  async snapshot() {
    const parent = await this.storage.readSession(this.parent);
    const child = await this.storage.readSession(this.child);
    assert(parent && child, "each transcript must have its own chat");
    return { parent, child, parentCheckpoint: await this.storage.readCheckpoint(this.parent),
      childCheckpoint: await this.storage.readCheckpoint(this.child) };
  }
}
