import assert from "node:assert/strict";
import { appendFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { test } from "node:test";
import { GlobalConfig } from "@tracerelic/collector/config";
import { CodexHistory } from "@tracerelic/collector/providers";
import type { Batch } from "@tracerelic/collector/storage";
import type { ReadPosition, ScanSelection } from "@tracerelic/collector/transcript";
import { CodexRolloutFixture as Rollout } from "../../fixtures/codex-rollout-fixture.ts";
import { ConfiguredCollector } from "../../fixtures/configured-collector.ts";
import { InMemoryCollectorStorage } from "../../fixtures/in-memory-collector-storage.ts";

const at = "2026-02-01T12:00:00Z";
const session = { harness: "codex", sessionId: "resumable" } as const;

test("a fresh scanner seeks to the last committed byte after an oversized batch is rejected", async t => {
  const root = await Rollout.create();
  t.after(() => root.close());
  const config = new GlobalConfig(root.home, undefined, "workstation");
  const storage = new InMemoryCollectorStorage();
  const scan = () => ConfiguredCollector.from(config, storage).scanOnce();
  const prompt = Rollout.message(at, "Same question");
  const file = await root.write([Rollout.header(session.sessionId), Rollout.turnContext(at, "first turn"), prompt]);
  const { size: acceptedBytes } = await stat(file);
  const large = { ...Rollout.message(at, "Large record"), padding: "x".repeat(300 * 1024) };
  await appendFile(file, [large, prompt].map(row => JSON.stringify(row) + "\n").join(""));
  const source = { ...session, installationId: "workstation", streamId: basename(file) };
  const commit = storage.commit.bind(storage);
  const rejectSecond = t.mock.method(storage, "commit", (batch: Batch) =>
    batch.expectedVersion === 1 ? Promise.resolve("invalid" as const) : commit(batch));
  await assert.rejects(scan(), /Storage returned invalid/);
  rejectSecond.mock.restore();
  const accepted = await storage.readCheckpoint(source);
  assert.equal(accepted.version, 1);
  assert.equal(accepted.checkpoint?.offset, acceptedBytes);
  assert.doesNotMatch(accepted.checkpoint.parserState, /Same question/);
  assert.deepEqual((await storage.readSession(session))?.messages.map(row => row.text), ["Same question"]);

  const starts: ReadPosition[] = [];
  const discover = CodexHistory.prototype.discoverSources;
  t.mock.method(CodexHistory.prototype, "discoverSources", async function* (
    this: CodexHistory, selection?: ScanSelection,
  ) {
    for await (const source of discover.call(this, selection)) {
      const read = t.mock.method(source, "readBatches");
      yield source;
      starts.push(...read.mock.calls.map(call => call.arguments[0]));
    }
  });
  const [view] = await scan();
  assert.deepEqual(starts[0], { offset: acceptedBytes, lineNumber: 3 });
  assert(starts.every(start => start.offset >= acceptedBytes && start.lineNumber >= 3));
  assert.deepEqual(view.messages.map(row => [row.text, row.turnId, row.sourceOrder]), [
    ["Same question", "first turn", 3], ["Large record", "first turn", 4], ["Same question", "first turn", 5],
  ]);
  assert.equal(new Set(view.messages.map(row => row.id)).size, 3);
  const completed = await storage.readCheckpoint(source);
  assert.equal(completed.version, 3);
  assert.equal(completed.checkpoint?.offset, (await stat(file)).size);
  assert.deepEqual(await scan(), [view]);
  assert.deepEqual(await storage.readCheckpoint(source), completed);
});

test("Codex imports the same native text blocks when paired rows cross several batches", async t => {
  const root = await Rollout.create();
  t.after(() => root.close());
  const config = new GlobalConfig(root.home);
  const scan = () => ConfiguredCollector.from(config, new InMemoryCollectorStorage()).scanOnce();
  const event = { timestamp: at, type: "event_msg", payload: { type: "user_message", message: "a🌍b" } };
  const typed = { timestamp: at, type: "response_item", payload: {
    type: "message", role: "user", id: "native-item", request_id: "r1",
    content: [{ type: "input_text", text: "a🌍" }, { type: "input_image" }, { type: "input_text", text: "b" }],
  } };
  const prefix = [Rollout.header(session.sessionId), event];
  const padding = { type: "padding", payload: {} };
  await root.write([...prefix, padding, padding, typed]);
  const [compact] = await scan();
  assert.deepEqual(compact.messages.map(({ id, sourceOrder, text }) => [id, sourceOrder, text]), [
    ["native:native-item:0", 2, "a🌍"], ["native:native-item:2", 2, "b"],
  ]);
  const large = { ...padding, data: "x".repeat(300 * 1024) };
  await root.write([...prefix, large, large, typed]);
  assert.deepEqual(await scan(), [compact]);
});

test("a legacy empty parser state is rebuilt through its accepted byte before importing new text", async t => {
  const root = await Rollout.create();
  t.after(() => root.close());
  const config = new GlobalConfig(root.home);
  const storage = new InMemoryCollectorStorage();
  const prompt = Rollout.message(at, "Same question");
  const file = await root.write([Rollout.header(session.sessionId), Rollout.turnContext(at, "first turn"), prompt]);
  const commit = storage.commit.bind(storage);
  const legacy = t.mock.method(storage, "commit", (batch: Batch) =>
    commit({ ...batch, checkpoint: { ...batch.checkpoint, parserState: "{}" } }));
  const [first] = await ConfiguredCollector.from(config, storage).scanOnce();
  legacy.mock.restore();
  await appendFile(file, JSON.stringify(prompt) + "\n");
  const [next] = await ConfiguredCollector.from(config, storage).scanOnce();
  assert.deepEqual(next.messages[0], first.messages[0]);
  assert.deepEqual(next.messages.map(row => [row.text, row.turnId, row.sourceOrder]), [
    ["Same question", "first turn", 3], ["Same question", "first turn", 4],
  ]);
  assert.notEqual(next.messages[0].id, next.messages[1].id);
  const source = { ...session, streamId: JSON.stringify([root.home, basename(file)]) };
  const progress = await storage.readCheckpoint(source);
  assert.equal(progress.version, 2);
  assert(progress.checkpoint);
  assert.equal(JSON.parse(progress.checkpoint.parserState).lineNumber, 4);
});

test("two installations can read the same transcript with independent offsets and a shared session", async t => {
  const root = await Rollout.create();
  t.after(() => root.close());
  const file = await root.write([Rollout.header(session.sessionId), Rollout.message(at, "Hello")]);
  const storage = new InMemoryCollectorStorage();
  const source = { ...session, streamId: basename(file) };
  const scan = (id: string) => ConfiguredCollector.from(new GlobalConfig(root.home, undefined, id), storage).scanOnce();
  const [first] = await scan("desktop");
  assert.deepEqual(await storage.readCheckpoint({ ...source, installationId: "laptop" }), { version: 1, checkpoint: null });
  assert.deepEqual(await scan("laptop"), [first]);
  await appendFile(file, JSON.stringify(Rollout.message(at, "Update")) + "\n");
  const [updated] = await scan("desktop");
  assert.deepEqual(updated.messages.map(row => row.text), ["Hello", "Update"]);
  const desktop = await storage.readCheckpoint({ ...source, installationId: "desktop" });
  const laptop = await storage.readCheckpoint({ ...source, installationId: "laptop" });
  assert(desktop.checkpoint && laptop.checkpoint);
  assert(desktop.checkpoint.offset > laptop.checkpoint.offset);
  assert.equal(laptop.version, desktop.version);
  assert.deepEqual(await scan("laptop"), [updated]);
});

test("an unreadable or newer parser state leaves the accepted position and chat intact", async t => {
  const root = await Rollout.create();
  t.after(() => root.close());
  const file = await root.write([Rollout.header(session.sessionId), Rollout.message(at, "First")]);
  const config = new GlobalConfig(root.home);
  const storage = new InMemoryCollectorStorage();
  const scan = () => ConfiguredCollector.from(config, storage).scanOnce();
  const [accepted] = await scan();
  const source = { ...session, streamId: JSON.stringify([root.home, basename(file)]) };
  const before = await storage.readCheckpoint(source);
  assert(before.checkpoint);
  await appendFile(file, JSON.stringify(Rollout.message(at, "Second")) + "\n");
  for (const parserState of ["private text", '{"version":99,"lineNumber":2,"decoder":{}}']) {
    const checkpoint = { ...before.checkpoint, parserState };
    const read = t.mock.method(storage, "readCheckpoint", async () => ({ version: before.version, checkpoint }));
    await assert.rejects(scan(), (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /parser (state|version)/);
      assert(error.message.includes(file));
      assert.doesNotMatch(error.message, /private text/);
      return true;
    });
    read.mock.restore();
    assert.deepEqual(await storage.readCheckpoint(source), before);
    assert.deepEqual(await storage.readSession(session), accepted);
  }
});
