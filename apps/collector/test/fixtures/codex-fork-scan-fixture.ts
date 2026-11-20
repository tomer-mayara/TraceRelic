import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CollectorCommand } from "@tracerelic/collector/command";
import { GlobalConfigLoader } from "@tracerelic/collector/config";
import { LocalLLMHistoryCodex } from "@tracerelic/collector/history";
import { CodexSessionParser } from "#src/scan/codex-session-parser";
import { TranscriptCursor } from "#src/scan/transcript-cursor";
import type { CollectorStorage, SessionView, StreamKey } from "../../src/storage/collector-storage.ts";
import { CodexRolloutFixture as Rollout } from "./codex-rollout-fixture.ts";
import { CodexUsageFixture as Usage } from "./codex-usage-fixture.ts";
import { InMemoryCollectorStorage } from "./in-memory-collector-storage.ts";

function at(second: number) { return new Date(Date.UTC(2026, 5, 1, 10, 0, second)).toISOString(); }

function counts(tokens: number) {
  const output = Math.floor(tokens / 5);
  return Usage.counts(tokens - output, output);
}

function header(id: string, second: number, fields: Record<string, unknown> = {}) {
  return { timestamp: at(second), type: "session_meta", payload: { id, session_id: "parent", timestamp: at(second), ...fields } };
}

function prefix(forkTotal: number, requestId = "parent-request") {
  return [
    header("parent", 0),
    Rollout.message(at(1), "Inherited plan"),
    { ...Usage.report(counts(80)), timestamp: at(2) },
    { ...Usage.report(counts(forkTotal), counts(20), { request_id: requestId }), timestamp: at(3) },
  ];
}

const childTurn = { turn_id: "child-turn" };
const childCall = { ...childTurn, request_id: "child-request" };
function startChildTurn() {
  return Usage.record("event_msg", { type: "task_started", ...childTurn, started_at: Date.parse(at(12)) / 1000 }, at(12));
}

export class CodexForkScanFixture {
  readonly storage = new InMemoryCollectorStorage();
  readonly parent = { harness: "codex", installationId: "desktop", sessionId: "parent", streamId: "rollout-parent.jsonl" } as const;
  readonly child = { harness: "codex", installationId: "desktop", sessionId: "child", streamId: "rollout-child.jsonl" } as const;
  private readonly configFile: string;

  private constructor(private readonly root: Rollout, private readonly archived: "child" | "parent") {
    this.configFile = join(root.home, "collector.json");
  }

  static async create(archived: "child" | "parent" = "parent") {
    const root = await Rollout.create();
    const fixture = new CodexForkScanFixture(root, archived);
    await writeFile(fixture.configFile, JSON.stringify({ codexPath: root.home, installationId: "desktop" }));
    return fixture;
  }

  close() { return this.root.close(); }

  private path(source: StreamKey) {
    const directory = source.sessionId === this.archived ? "archived_sessions" : "sessions";
    return join(this.root.home, directory, source.streamId);
  }

  private async write(source: StreamKey, lines: string[]) {
    const file = this.path(source);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, lines.join(""));
  }

  async writeParent(forkTotal: number, currentTotal: number, requestId?: string) {
    const rows = [...prefix(forkTotal, requestId), { ...Usage.report(counts(currentTotal)), timestamp: at(20) }];
    await this.write(this.parent, rows.map(row => JSON.stringify(row) + "\n"));
  }

  async shortenParent(keepFull: boolean) {
    const original = this.path(this.parent);
    const prefix = (await readFile(original, "utf8")).split("\n").slice(0, 3).join("\n") + "\n";
    const target = keepFull ? join(dirname(original), "rollout-earlier-parent.jsonl") : original;
    await writeFile(target, prefix);
  }

  async appendTotal(source: StreamKey, total: number) {
    const row = { ...Usage.report(counts(total)), timestamp: at(21) };
    await appendFile(this.path(source), JSON.stringify(row) + "\n");
  }

  async writeNative(session: "child" | "parent", rows: object[]) {
    const metadata = session === "child" ? { forked_from_id: "parent" } : {};
    const timestamp = session === "child" ? "2026-02-01T12:00:03Z" : "2026-02-01T12:00:00Z";
    const records = [{ timestamp, type: "session_meta", payload: { id: session, timestamp, ...metadata } }, ...rows];
    await this.write(this[session], records.map(row => JSON.stringify(row) + "\n"));
  }

  async writeChildWithFreshCall(firstAmount: number, total: number) {
    const first = counts(firstAmount);
    const rows = [header("child", 10, { forked_from_id: "parent" }), startChildTurn(),
      { ...Usage.report(undefined, first, childCall), timestamp: at(13) },
      { ...Usage.report(first, first, childCall), timestamp: at(14) },
      { ...Usage.report(counts(total)), timestamp: at(15) }];
    await this.write(this.child, rows.map(row => JSON.stringify(row) + "\n"));
  }

  async writeChild(forkTotal: number, currentTotal: number, freshCounter = false) {
    const forkSecond = 10;
    const copied = prefix(forkTotal).map(row => ({ ...row, timestamp: at(forkSecond) }));
    const ownReports = freshCounter
      ? [{ ...Usage.report(counts(currentTotal), counts(currentTotal), childCall), timestamp: at(15) }]
      : [
        { ...Usage.report(undefined, counts(5), childCall), timestamp: at(14) },
        { ...Usage.report(counts(currentTotal)), timestamp: at(15) },
      ];
    const rows = [
      header("child", forkSecond, { forked_from_id: "parent" }), ...copied,
      startChildTurn(), Rollout.message(at(13), "Child plan"), ...ownReports,
    ];
    const lines = rows.map(row => JSON.stringify(row) + "\n");
    await this.write(this.child, lines);
    const firstReport = rows.findIndex(row => row.type === "event_msg");
    const startOffset = Buffer.byteLength(lines.slice(0, firstReport).join(""));
    const inherited = counts(forkTotal);
    return {
      baseline: { inputTokens: inherited.input_tokens, outputTokens: inherited.output_tokens },
      firstUncertain: { offset: startOffset, lineNumber: firstReport + 1 },
      byteRange: { startOffset, endOffset: startOffset + Buffer.byteLength(lines[firstReport]) },
      inheritedThrough: { offset: Buffer.byteLength(lines.slice(0, 1 + copied.length).join("")), lineNumber: 1 + copied.length },
    };
  }

  async discover() {
    const reader = new LocalLLMHistoryCodex(await GlobalConfigLoader.load(this.configFile));
    return Array.fromAsync(reader.discoverSources());
  }

  async importLegacyChild() {
    const child = (await this.discover()).find(source => source.sessionId === this.child.sessionId);
    assert(child);
    // The version 2 writer interpreted every stream on its own and saved no fork evidence.
    const cursor = await TranscriptCursor.restore(child, null, CodexSessionParser);
    for await (const { chat, checkpoint } of cursor.read(child)) {
      assert.equal(JSON.parse(checkpoint.parserState).version, 2);
      const { messages, metadata, usage, usageWindows, usageAnchors, hasGap } = chat;
      assert.equal(await this.storage.commit({
        source: this.child, expectedVersion: 0, expectedOffset: 0, checkpoint,
        messages, metadata, usage: usage ?? [], usageWindows, usageAnchors, hasGap,
      }), "committed");
    }
  }

  scan(...ids: string[]): Promise<readonly SessionView[]> { return this.scanWith(this.storage, ...ids); }

  async scanWith(storage: CollectorStorage, ...ids: string[]): Promise<readonly SessionView[]> {
    const command = new CollectorCommand(storage);
    const result = await command.run(["scan", "--once", "--config", this.configFile, ...ids.flatMap(id => ["--session", id])]);
    return result.map(view => {
      assert("usage" in view);
      return view;
    });
  }

  async checkpoints() {
    return { child: await this.storage.readCheckpoint(this.child), parent: await this.storage.readCheckpoint(this.parent) };
  }
}
