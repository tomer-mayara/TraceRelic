import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, chmod, readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { GlobalConfig } from "@tracerelic/collector/config";
import { CodexHistory } from "@tracerelic/collector/providers";
import { ScanPendingError } from "@tracerelic/collector/scan";
import { ClaudeProjectFixture as Claude } from "../../fixtures/claude-project-fixture.ts";
import { ConfiguredCollector } from "../../fixtures/configured-collector.ts";
import { MissingSourceFixture } from "../../fixtures/missing-source-fixture.ts";
import { CountSessionReads, rotateClaude, rotateCodex, unacceptedAppend } from "../../fixtures/scan-repair-fixture.ts";
import { ScheduledScanFixture } from "../../fixtures/scheduled-scan-fixture.ts";

for (const lost of ["request", "reply"] as const) {
  test(`an offline read preserves the generation's greatest verified end after a lost ${lost}`, async t => {
    const files = await MissingSourceFixture.create();
    t.after(() => files.close());
    const pending = await unacceptedAppend(files, lost);
    const original = await readFile(files.transcript.file);
    const [missing] = await pending.disappear();
    assert.equal(missing.coverage, lost === "request" ? "partial" : "reported");
    assert.equal(missing.observedTotalTokens, lost === "request" ? 70 : 95);
    assert.deepEqual(files.reports, [files.missing(lost === "request" ? pending.accepted : pending.end, pending.end)]);
    assert.deepEqual(await pending.scanner.scanOnce(), [missing]);
    await writeFile(files.transcript.file, original);
    const [restored] = await pending.scanner.scanOnce();
    assert.equal(restored.coverage, "reported");
    assert.equal(restored.observedTotalTokens, 95);
    assert.equal(restored.missingSources, undefined);
  });
}

for (const reset of [false, true]) {
  test(`a volatile suffix follows only the original generation after another writer ${reset ? "resets" : "appends elsewhere"}`, async t => {
    const files = await MissingSourceFixture.create();
    t.after(() => files.close());
    const { store, scanner, accepted, end } = await unacceptedAppend(files);
    const { source, file } = files.transcript;
    await rm(file);
    store.offline = false;
    const { version, checkpoint } = await store.readCheckpoint(source);
    assert(checkpoint?.prefixDigest);
    const otherDigest = "b".repeat(64);
    const target = reset ? source : { ...source, streamId: "other-stream" };
    const replacement = { ...checkpoint, prefixDigest: otherDigest };
    assert.equal(await store.commit({ source: target, expectedVersion: version, expectedOffset: reset ? accepted : 0,
      checkpoint: replacement, ...(reset && { resetFrom: checkpoint, sourceObservation: {
        location: { root: files.transcript.root.home, path: source.streamId }, observedEnd: accepted, observedPrefixDigest: otherDigest } }),
      messages: [], usage: [] }), "committed");
    const [missing] = await scanner.scanOnce();
    assert.deepEqual(missing.missingSources, [files.missing(accepted, reset ? accepted : end)]);
    assert.equal(missing.coverage, reset ? "reported" : "partial");
  });
}

test("a second disappearance extends the proved loss through the newer suffix", async t => {
  const files = await MissingSourceFixture.create();
  t.after(() => files.close());
  const pending = await unacceptedAppend(files);
  const { scanner, store } = pending;
  const { file, source } = files.transcript;
  const first = await readFile(file);
  await pending.disappear();
  await writeFile(file, first);
  await files.transcript.append(files.transcript.call("newer-call", 5));
  const second = await readFile(file, "utf8");
  store.loseFirstUpload = "request";
  await assert.rejects(scanner.scanOnce(), ScanPendingError);
  await rm(file);
  await scanner.scanOnce();
  const proof = (await store.readCheckpoint(source)).observedThrough;
  assert.deepEqual(proof, { offset: Buffer.byteLength(second), prefixDigest: createHash("sha256").update(second).digest("hex") });
  await writeFile(file, second.replace("newer-call", "other-call"));
  const [different] = await scanner.scanOnce();
  assert.equal(different.coverage, "partial");
  await writeFile(file, second);
  const [complete] = await scanner.scanOnce();
  assert.equal(complete.coverage, "reported");
});

test("a Claude rotation imports a verified continuation without a native row UUID", async t => {
  const f = await MissingSourceFixture.create();
  t.after(() => f.close());
  const { args, texts } = await rotateClaude(f);
  for (let pass = 0; pass < 2; pass++) {
    const [view] = await f.scan(args);
    assert.deepEqual(view.messages.map(row => row.text), texts);
    assert.equal(view.missingSources, undefined);
  }
});

for (const alreadyMissing of [false, true]) {
  test(`only the backup containing the original complete suffix can heal it (already missing: ${alreadyMissing})`, async t => {
    const f = await MissingSourceFixture.create();
    t.after(() => f.close());
    const { claude, args } = await f.useClaude();
    const store = f.transcript.storage;
    const at = "2026-02-01T12:00:00Z";
    const file = await claude.write("p", "rotation", [{ ...Claude.assistant("chat", at, "Known"), uuid: "known", cwd: "/work" }]);
    const selected = [...args, "--project", "/work"];
    await f.scan(selected);
    const prefix = await readFile(file, "utf8");
    const suffix = JSON.stringify(Claude.user("chat", at, "right")) + "\n";
    const [ack] = await store.listSources({ harness: "claude", root: claude.home, installationId: "desktop" });
    const observedEnd = Buffer.byteLength(prefix + suffix);
    await store.recordPresence({ source: ack.source, expectedVersion: ack.version, expectedOffset: ack.acceptedOffset,
      location: ack.location, presence: "present", observedEnd, observedPrefixDigest: createHash("sha256").update(prefix + suffix).digest("hex") });
    await rm(file);
    if (alreadyMissing) assert.equal((await f.scan(selected))[0].coverage, "partial");
    await writeFile(file + ".superseded-001", prefix + suffix.replace("right", "wrong"));
    await writeFile(file + ".superseded-002", prefix + suffix);
    const [first] = await f.scan(selected);
    assert.deepEqual(first.messages.map(m => m.text), ["Known", "right"]);
    assert.equal(first.coverage, "reported");
    assert.equal(first.missingSources, undefined);
    assert.deepEqual(await f.scan(selected), [first]);
  });
}

test("two equally plausible Claude rotations preserve only the proven current prefix", async t => {
  const f = await MissingSourceFixture.create();
  t.after(() => f.close());
  const { claude, args } = await f.useClaude();
  const at = "2026-02-01T12:00:00Z";
  const file = await claude.write("p", "chat", [{ ...Claude.user("chat", at, "Original"), uuid: "accepted" }]);
  await f.scan(args);
  const prefix = await readFile(file, "utf8");
  await rm(file);
  for (const [i, text] of ["alpha", "bravo"].entries()) {
    await writeFile(file + ".superseded-00" + i, prefix + JSON.stringify(Claude.user("chat", at, text)) + "\n");
  }
  const [view] = await f.scan(args);
  assert.deepEqual(view.messages.map(m => m.text), ["Original"]);
  assert.deepEqual(await f.scan(args), [view]);
});

for (const backup of ["contradicts", "ends before"] as const) {
  test(`a rotation that ${backup} the original suffix leaves the accepted byte and its gap intact`, async t => {
    const f = await MissingSourceFixture.create();
    t.after(() => f.close());
    const { claude, args } = await f.useClaude();
    const at = "2026-02-01T12:00:00Z";
    const file = await claude.write("project", "chat", [{ ...Claude.assistant("chat", at, "Original"), uuid: "accepted" }]);
    await f.scan(args);
    const prefix = await readFile(file, "utf8");
    const suffix = JSON.stringify(Claude.user("chat", at, "right")) + "\n";
    const store = f.transcript.storage;
    const scope = { harness: "claude" as const, root: claude.home, installationId: "desktop" };
    const [ack] = await store.listSources(scope);
    const observedEnd = Buffer.byteLength(prefix + suffix);
    await store.recordPresence({ source: ack.source, expectedVersion: ack.version, expectedOffset: ack.acceptedOffset,
      location: ack.location, presence: "present", observedEnd, observedPrefixDigest: createHash("sha256").update(prefix + suffix).digest("hex") });
    await rm(file);
    await writeFile(file + ".superseded-001", prefix + (backup === "contradicts" ? suffix.replace("right", "wrong") : ""));
    const [view] = await f.scan(args);
    assert.deepEqual(view.messages.map(m => m.text), ["Original"]);
    assert.equal(view.coverage, "partial");
    assert.equal(view.missingSources, undefined);
    const current = (await store.listSources(scope)).find(row => row.source.streamId === ack.source.streamId);
    assert.equal(current?.acceptedOffset, ack.acceptedOffset);
    assert.deepEqual(await f.scan(args), [view]);
  });
}

test("a readable backup of another generation cannot mask the original's first disappearance", async t => {
  const f = await MissingSourceFixture.create();
  t.after(() => f.close());
  const { claude, args } = await f.useClaude();
  const at = "2026-02-01T12:00:00Z";
  const file = await claude.write("p", "chat", [{ ...Claude.assistant("chat", at, "Original"), uuid: "m", marker: "A" }]);
  await f.scan(args);
  const prefix = await readFile(file, "utf8");
  const [ack] = await f.transcript.storage.listSources({ harness: "claude", root: claude.home, installationId: "desktop" });
  const suffix = JSON.stringify(Claude.user("chat", at, "Unaccepted")) + "\n";
  const observedEnd = Buffer.byteLength(prefix + suffix);
  await f.transcript.storage.recordPresence({ source: ack.source, expectedVersion: ack.version, expectedOffset: ack.acceptedOffset,
    location: ack.location, presence: "present", observedEnd, observedPrefixDigest: createHash("sha256").update(prefix + suffix).digest("hex") });
  await rm(file);
  await writeFile(file + ".superseded-001", prefix.replace('"marker":"A"', '"marker":"B"'));
  const [view] = await f.scan(args);
  assert.equal(view.coverage, "partial");
  assert.deepEqual(view.missingSources, [{ status: "missing", source: ack.source, acceptedOffset: ack.acceptedOffset, observedEnd }]);
  assert.deepEqual(await f.scan(args), [view]);
});

test("an unreadable named backup leaves the original's presence undetermined", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async t => {
  const f = await MissingSourceFixture.create();
  t.after(() => f.close());
  const { claude, args } = await f.useClaude();
  const path = await claude.write("project", "chat", [{ ...Claude.user("chat", "2026-02-01T12:00:00Z", "Known"), uuid: "accepted" }]);
  const [before] = await f.scan(args);
  const backup = path + ".superseded-123";
  await writeFile(backup, await readFile(path), { mode: 0 });
  await rm(path);
  await f.scan(args);
  assert.deepEqual(f.reports, []);
  const store = f.transcript.storage;
  assert.deepEqual(await store.readSession(before.key), before);
  await chmod(backup, 0o600);
  assert.deepEqual(await f.scan(args), [before]);
});

for (const backup of ["matching", "different prefix", "different suffix", "unidentified", "wrong session"] as const) {
  test(`Claude requires identity and suffix proof after restart (${backup} backup)`, async t => {
    const f = await MissingSourceFixture.create();
    t.after(() => f.close());
    const { claude } = await f.useClaude();
    const store = f.transcript.storage;
    const scanner = () => ConfiguredCollector.from(new GlobalConfig(f.transcript.root.home, claude.home, "desktop"), store);
    const row = { ...Claude.assistant("chat", "2026-02-01T12:00:00Z", "Known"), uuid: "known", marker: "A" };
    const path = await claude.write("project", "chat", [row]);
    await scanner().scanOnce();
    const prefix = await readFile(path, "utf8");
    const extra = JSON.stringify({ sessionId: "chat", marker: "A" }) + "\n";
    await appendFile(path, extra);
    const active = scanner();
    const reject = t.mock.method(store, "commit", async () => "invalid" as const);
    await assert.rejects(active.scanOnce());
    reject.mock.restore();
    await rm(path);
    await active.scanOnce();
    const original = await store.readSession({ harness: "claude", sessionId: "chat" });
    assert.equal(original?.coverage, "partial");
    const content = backup === "unidentified" ? "{unfinished" : backup === "wrong session" ? prefix.replaceAll('"chat"', '"else"') :
      (backup === "different prefix" ? prefix.replace('"marker":"A"', '"marker":"B"') : prefix)
      + (backup === "different suffix" ? extra.replace('"A"', '"B"') : extra);
    await writeFile(path + ".superseded-123", content);
    await scanner().scanOnce();
    const returned = await store.readSession({ harness: "claude", sessionId: "chat" });
    assert.equal(returned?.coverage, backup === "matching" ? "reported" : "partial");
    assert.equal(Boolean(returned?.missingSources?.length), backup !== "matching" && backup !== "different suffix");
  });
}

for (const unstable of [false, true]) {
  test(`a moving source is retried locally and an independent file is collected (keeps changing: ${unstable})`, async t => {
    const files = await MissingSourceFixture.create();
    t.after(() => files.close());
    const moving = await rotateCodex(files.transcript, unstable);
    const discovery = t.mock.method(CodexHistory.prototype, "discoverSources");
    if (unstable) await assert.rejects(moving.scan(), e => e instanceof ScanPendingError && e.pending.reason === "source-changed");
    else assert.deepEqual((await moving.scan()).map(view => "key" in view ? view.key.sessionId : view.sessionId).sort(), ["healthy", "s"]);
    assert(await moving.store.readSession({ harness: "codex", sessionId: "healthy" }));
    assert(moving.moves() <= 2);
    assert.deepEqual(discovery.mock.calls.map(call => call.arguments[1]?.sourceFile), [undefined, files.transcript.file]);
  });
}

test("watch requests zero final conversation views over two unchanged ticks", async t => {
  const f = await MissingSourceFixture.create();
  t.after(() => f.close());
  const store = new CountSessionReads();
  await f.scan(f.args, store);
  const initial = store.reads;
  const watch = new ScheduledScanFixture(store, f.args.slice(2));
  try {
    await watch.waitForPass();
    await watch.advance();
    await watch.advance();
    assert.deepEqual(watch.reports.map(r => r.newSessions), [0, 0, 0]);
    assert.equal(store.reads, initial);
    assert.equal((await f.scan(f.args, store)).length, 1);
  } finally { await watch.stop(); }
});
