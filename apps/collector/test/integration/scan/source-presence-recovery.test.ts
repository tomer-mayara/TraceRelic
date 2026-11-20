import assert from "node:assert/strict";
import { copyFile, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { GlobalConfig } from "@tracerelic/collector/config";
import { LocalCollector, ScanPendingError } from "@tracerelic/collector/scan";
import { StorageBackoffError } from "@tracerelic/collector/storage";
import type { MissingSource } from "../../../src/storage/collector-storage.ts";
import { CodexRolloutFixture as Rollout } from "../../fixtures/codex-rollout-fixture.ts";
import { PresenceConnection } from "../../fixtures/presence-connection.ts";

for (const lost of ["request", "reply"] as const) {
  test(`losing the first upload's ${lost} reports only a confirmed accepted byte`, async t => {
    const root = await Rollout.create();
    t.after(() => root.close());
    const path = await root.write([Rollout.header("work")]);
    const observedEnd = (await stat(path)).size;
    const source = { harness: "codex", sessionId: "work", streamId: basename(path), installationId: "home" };
    const config = new GlobalConfig(root.home, undefined, "home");
    const storage = new PresenceConnection();
    const reports: MissingSource[] = [];
    const scanner = new LocalCollector(config, storage, undefined, report => reports.push(report));
    storage.loseFirstUpload = lost;
    await assert.rejects(scanner.scanOnce(), ScanPendingError);

    storage.offline = true;
    // Seeing the same file again cannot confirm or erase the outcome of the earlier upload.
    await assert.rejects(scanner.scanOnce(), ScanPendingError);
    await rm(path);
    await assert.rejects(scanner.scanOnce(), ScanPendingError);
    const local = { status: "missing", source, acceptedOffset: 0, observedEnd };
    assert.deepEqual(reports, lost === "request" ? [local] : []);
    await assert.rejects(scanner.scanOnce(), ScanPendingError);
    assert.equal(reports.length, lost === "request" ? 1 : 0);
    storage.offline = false;
    const views = await scanner.scanOnce();
    assert.equal(views.length, lost === "request" ? 0 : 1);
    assert.deepEqual(reports, [{ ...local, acceptedOffset: lost === "request" ? 0 : observedEnd }]);
    await new LocalCollector(config, storage, undefined, report => reports.push(report)).scanOnce();
    assert.equal(reports.length, 1);
  });
}

test("a running scanner names a vanished source while its first checkpoint is still unknown", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const root = await Rollout.create();
  t.after(() => root.close());
  const file = await root.write([Rollout.header("work")]);
  const source = { harness: "codex", sessionId: "work", streamId: basename(file), installationId: "desktop" };
  const observedEnd = (await stat(file)).size;
  const reports: MissingSource[] = [];
  const storage = new PresenceConnection();
  const scanner = new LocalCollector(new GlobalConfig(root.home, undefined, "desktop"), storage, undefined, report => reports.push(report));
  storage.offline = true;
  await assert.rejects(scanner.scanOnce(), ScanPendingError);
  await rm(file);
  const list = t.mock.method(storage, "listSources");
  list.mock.mockImplementationOnce(() => { throw new StorageBackoffError(12_000); });
  await assert.rejects(scanner.scanOnce(), (error: unknown) => {
    assert(error instanceof ScanPendingError);
    assert.deepEqual(error.pending.source, source);
    assert.equal(error.pending.retryAt, "1970-01-01T00:00:12.000Z");
    return true;
  });
  assert.deepEqual(reports, []);
  storage.offline = false;
  assert.deepEqual(await scanner.scanOnce(), []);
  assert.deepEqual(reports, [{ status: "missing", source, acceptedOffset: 0, observedEnd }]);
  assert.deepEqual(await scanner.scanOnce(), []);
  assert.equal(reports.length, 1);
});

test("a lost presence reply is confirmed from storage and the disappearance is emitted once", async t => {
  const root = await Rollout.create();
  t.after(() => root.close());
  const path = await root.write([Rollout.header("work")]);
  const storage = new PresenceConnection();
  const reports: MissingSource[] = [];
  const scanner = new LocalCollector(new GlobalConfig(root.home), storage, undefined, report => reports.push(report));
  await scanner.scanOnce();
  await rm(path);
  storage.losePresenceReply = true;
  const [view] = await scanner.scanOnce();
  assert.equal(reports.length, 1);
  assert.deepEqual(reports, view.missingSources);
  assert.deepEqual(await scanner.scanOnce(), [view]);
  assert.equal(reports.length, 1);
});

test("two disappearing streams of one session are reported once each and both can return without an append", async t => {
  const root = await Rollout.create();
  t.after(() => root.close());
  const path = await root.write([Rollout.header("work")]);
  const second = join(dirname(path), "rollout-peer.jsonl");
  await copyFile(path, second);
  const data = await readFile(path);
  const storage = new PresenceConnection();
  const reports: MissingSource[] = [];
  const scanner = new LocalCollector(new GlobalConfig(root.home), storage, undefined, report => reports.push(report));
  const [before] = await scanner.scanOnce();
  await Promise.all([rm(path), rm(second)]);
  const [gone] = await scanner.scanOnce();
  assert.equal(reports.length, 2);
  assert.deepEqual(gone.missingSources, reports);
  assert.deepEqual(await scanner.scanOnce(), [gone]);
  await Promise.all([writeFile(path, data), writeFile(second, data)]);
  assert.deepEqual(await scanner.scanOnce(), [before]);
  assert.equal(reports.length, 2);
});

test("a presence conflict requires a fresh search before reporting a disappearance", async t => {
  const root = await Rollout.create();
  t.after(() => root.close());
  const path = await root.write([Rollout.header("work")]);
  const storage = new PresenceConnection();
  const reports: MissingSource[] = [];
  const scanner = new LocalCollector(new GlobalConfig(root.home), storage, undefined, report => reports.push(report));
  const [before] = await scanner.scanOnce();
  const bytes = await readFile(path);
  await rm(path);
  storage.interruptPresence = () => writeFile(path, bytes);
  await scanner.scanOnce();
  assert.deepEqual(reports, []);
  assert.deepEqual(await scanner.scanOnce(), [before]);
});

test("a missing write retried after a reset uses the replacement's complete end at the same byte", async t => {
  const root = await Rollout.create();
  t.after(() => root.close());
  const path = await root.write([Rollout.header("work")]);
  const storage = new PresenceConnection();
  const reports: MissingSource[] = [];
  const scanner = new LocalCollector(new GlobalConfig(root.home, undefined, "station"), storage, undefined, report => reports.push(report));
  await scanner.scanOnce();
  const source = { harness: "codex" as const, sessionId: "work", streamId: basename(path), installationId: "station" };
  const location = { root: root.home, path: source.streamId };
  const before = await storage.readCheckpoint(source);
  const checkpoint = before.checkpoint;
  assert(checkpoint);
  const accepted = checkpoint.offset;
  assert.equal(await storage.recordPresence({ source, location, presence: "present", expectedOffset: accepted, expectedVersion: before.version,
    observedEnd: accepted + 80 }), "committed");
  await rm(path);
  storage.interruptPresence = async () => {
    const replacement = { ...checkpoint, prefixDigest: "b".repeat(64) };
    assert.equal(await storage.commit({ source, expectedVersion: before.version + 1, expectedOffset: accepted,
      checkpoint: replacement, resetFrom: checkpoint, messages: [], usage: [], sourceObservation: { location, observedEnd: accepted } }), "committed");
  };
  await scanner.scanOnce();
  assert.deepEqual(reports, [{ status: "missing", source, acceptedOffset: accepted, observedEnd: accepted }]);
});
