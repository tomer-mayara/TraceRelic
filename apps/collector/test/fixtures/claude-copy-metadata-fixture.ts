import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { LocalCollector } from "@tracerelic/collector/scan";
import type { Batch, CollectorStorage, Metadata } from "@tracerelic/collector/storage";
import { ClaudeProjectFixture } from "./claude-project-fixture.ts";

const at = "2026-02-01T12:00:00Z";
const key = { harness: "claude" as const, sessionId: "planning" };
interface Entry { uuid: string; cwd?: string; repository?: string; gitBranch?: string; forkedFrom?: { sessionId: string }; timestamp: string }

/** Native UUIDs give the old version-two Claude decoder an empty occurrence map. */
export class ClaudeCopyMetadataFixture {
  readonly key = key;
  private constructor(private readonly projects: ClaudeProjectFixture, private readonly archiveName: string) {}

  static async create(orphaned = false) {
    return new ClaudeCopyMetadataFixture(await ClaudeProjectFixture.create(),
      orphaned ? "planning.orphaned-2026-before.jsonl" : "planning.jsonl.superseded-2026");
  }

  close() { return this.projects.close(); }

  async seed(store: CollectorStorage, peer?: "before backup" | "after backup") {
    const peerSource = { ...key, streamId: "other-source", installationId: "other" };
    const peerCheckpoint = { offset: 10, parserState: JSON.stringify({ version: 2, lineNumber: 1, decoder: { occurrences: {} } }),
      prefixDigest: "a".repeat(64), claudeCallOrigins: true as const };
    const other = (version: number) => store.commit({ source: peerSource, expectedVersion: version, expectedOffset: 0,
      checkpoint: peerCheckpoint, metadata: { repository: "first backup value" }, messages: [], usage: [] });
    let version = await this.acknowledge(store, "planning.jsonl", [
      { uuid: "current", cwd: "/current", gitBranch: "current-branch", forkedFrom: { sessionId: "current-parent" }, timestamp: at },
    ], [{ cwd: "/current", branch: "current-branch", parentSessionId: "current-parent" }], 0);
    if (peer === "before backup") assert.equal(await other(version++), "committed");
    version = await this.acknowledge(store, this.archiveName, [
      { uuid: "backup", cwd: "/old", repository: "first backup value", gitBranch: "older-branch",
        forkedFrom: { sessionId: "backup-parent" }, timestamp: "2026-01-01T12:00:00Z" },
      { uuid: "appended", cwd: "/later-old", repository: peer ? "first backup value" : "later backup value", timestamp: "2026-01-01T12:01:00Z" },
    ], [peer === "before backup" ? { branch: "older-branch" } : { repository: "first backup value", branch: "older-branch" }, {}], version);
    if (peer === "after backup") assert.equal(await other(version), "committed");
    return async (target: CollectorStorage, replacement?: string) => {
      const current = await target.readCheckpoint(peerSource);
      assert.equal(await target.commit({ source: peerSource, expectedVersion: current.version, expectedOffset: peerCheckpoint.offset,
        repairEvidenceFrom: peerCheckpoint, checkpoint: { ...peerCheckpoint, evidenceVersion: 1 },
        metadata: replacement === undefined ? {} : { repository: replacement }, messages: [], usage: [] }), "committed");
      return target.readSession(key);
    };
  }

  scan(store: CollectorStorage) {
    return new LocalCollector({ codexPath: join(this.projects.home, "codex"), claudePath: this.projects.home, installationId: "desktop" }, store).scanOnce();
  }

  appendCopyWithOrigin(parentSessionId: string) {
    const record = { ...ClaudeProjectFixture.assistant(key.sessionId, at, "Copied answer"), uuid: "copied-answer",
      forkedFrom: { sessionId: parentSessionId, messageUuid: "another-parent-row" } };
    return appendFile(join(this.projects.home, "projects", "workspace", this.archiveName), JSON.stringify(record) + "\n");
  }

  private async acknowledge(store: CollectorStorage, name: string, entries: Entry[], accepted: Metadata[], version: number) {
    const projectDir = join(this.projects.home, "projects", "workspace");
    const file = join(projectDir, name);
    await mkdir(dirname(file), { recursive: true });
    const path = relative(this.projects.home, file);
    let bytes = "";
    for (const [i, entry] of entries.entries()) {
      const expectedOffset = Buffer.byteLength(bytes);
      const text = "Message " + entry.uuid;
      bytes += JSON.stringify({ ...ClaudeProjectFixture.user(key.sessionId, entry.timestamp, text), ...entry }) + "\n";
      const offset = Buffer.byteLength(bytes);
      const metadata = accepted[i];
      const context = { ...(entry.cwd && { cwd: entry.cwd }), ...(entry.repository && { repository: entry.repository }),
        ...(entry.gitBranch && { branch: entry.gitBranch }) };
      const batch: Batch = {
        source: { ...key, installationId: "desktop", streamId: path }, expectedVersion: version, expectedOffset,
        sourceObservation: { location: { root: this.projects.home, path, projectDir, cwd: entries[0].cwd,
          ...(name === this.archiveName && { currentFileCwd: "/current" }) }, observedEnd: offset },
        // These are the accepted batch fields of the pre-evidence scanner. Backup fallback was decided at each scan.
        checkpoint: { offset, parserState: JSON.stringify({ version: 2, lineNumber: i + 1, decoder: { occurrences: {} } }),
          prefixDigest: createHash("sha256").update(bytes).digest("hex"), claudeCallOrigins: true },
        metadata, ...(metadata.branch && { branchObservation: { sourceOrder: i + 1, at: entry.timestamp } }),
        messages: [{ id: "native:" + entry.uuid + ":0", at: entry.timestamp, role: "user", text, sourceOrder: i + 1, blockIndex: 0, context }],
        usage: [],
      };
      assert.equal(await store.commit(batch), "committed");
      version++;
    }
    await writeFile(file, bytes);
    return version;
  }
}
