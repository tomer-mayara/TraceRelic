import assert from "node:assert/strict";
import { appendFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { GlobalConfig } from "@tracerelic/collector/config";
import { LocalCollector, ScanPendingError } from "@tracerelic/collector/scan";
import type { SessionKey, StreamKey } from "../../src/storage/collector-storage.ts";
import { ClaudeProjectFixture as Claude } from "./claude-project-fixture.ts";
import { CodexRolloutFixture as Codex } from "./codex-rollout-fixture.ts";
import { InMemoryCollectorStorage } from "./in-memory-collector-storage.ts";
import type { MissingSourceFixture } from "./missing-source-fixture.ts";
import { PresenceConnection } from "./presence-connection.ts";
import type { RewriteScanFixture } from "./rewrite-scan-fixture.ts";

export class CountSessionReads extends InMemoryCollectorStorage {
  reads = 0;
  override async readSession(key: SessionKey) {
    this.reads++;
    return super.readSession(key);
  }
}

export async function unacceptedAppend(files: MissingSourceFixture, lost: "request" | "reply" = "request") {
  const store = new PresenceConnection();
  const f = files.transcript;
  const scanner = new LocalCollector(new GlobalConfig(f.root.home, undefined, "desktop"), store, undefined, r => files.reports.push(r));
  await f.write([f.call("original", 70)]);
  await scanner.scanOnce();
  const accepted = (await stat(f.file)).size;
  await f.append(f.call("additional", 25));
  const end = (await stat(f.file)).size;
  store.loseFirstUpload = lost;
  await assert.rejects(scanner.scanOnce(), ScanPendingError);
  store.offline = true;
  await assert.rejects(scanner.scanOnce(), ScanPendingError);
  return { scanner, store, accepted, end, async disappear() {
    await rm(f.file);
    store.offline = false;
    return scanner.scanOnce();
  } };
}

export async function rotateClaude(files: MissingSourceFixture) {
  const { claude, args } = await files.useClaude();
  const row = Claude.user("chat", "2026-02-01T12:00:00Z", "Original");
  const path = await claude.write("project", "chat", [{ ...row, uuid: "original" }]);
  await files.scan(args);
  await appendFile(path, JSON.stringify(Claude.user("chat", "2026-02-01T12:00:01Z", "Anonymous continuation")) + "\n");
  await rename(path, path + ".superseded-123");
  return { args, texts: ["Original", "Anonymous continuation"] };
}

export async function rotateCodex(f: RewriteScanFixture, keepChanging = false) {
  const archive = join(f.root.home, "archived_sessions", basename(f.file));
  await mkdir(dirname(archive), { recursive: true });
  const good = join(f.root.home, "archived_sessions", "rollout-healthy.jsonl");
  await writeFile(good, JSON.stringify(Codex.header("healthy")) + "\n");
  let moves = 0;
  class MovingStorage extends InMemoryCollectorStorage {
    override async readCheckpoint(source: StreamKey) {
      if (source.sessionId === "s" && (moves === 0 || keepChanging)) {
        await rename(moves % 2 ? archive : f.file, moves % 2 ? f.file : archive);
        moves++;
      }
      return super.readCheckpoint(source);
    }
  }
  const store = new MovingStorage();
  return { scan: () => f.scanAll(store), store, moves: () => moves };
}
