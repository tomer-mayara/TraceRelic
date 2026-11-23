import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalCollector } from "@tracerelic/collector/scan";
import type { AcknowledgedSource, SessionView } from "@tracerelic/collector/storage";
import { MockScanProvider, MockTranscript, PreparingFormat } from "../../fixtures/mock-scan-provider.ts";
import { ScanPassFixture } from "../../fixtures/provider-scan-fixture.ts";
import { RecordingCollectorStorage } from "../../fixtures/recording-collector-storage.ts";

/** A source that storage acknowledges under /mock and that no pass discovers. */
const gone: AcknowledgedSource = {
  source: { harness: "codex", sessionId: "gone", streamId: "mock:/mock/gone.jsonl" },
  location: { root: "/mock", path: "gone.jsonl" }, observedEnd: 20, acceptedOffset: 20, version: 1, presence: "present",
};

test("imports each discovered group of a provider that is neither Codex nor Claude Code", async () => {
  const one = new MockTranscript("/mock/chats/one.jsonl", "one", ["Plan search", "Use an index"]);
  const two = new MockTranscript("/mock/chats/two.jsonl", "two", ["Measure latency"]);
  const provider = new MockScanProvider({ harness: "codex", root: "/mock", groups: [[one], [two]] });
  const storage = new RecordingCollectorStorage();
  const selection = { sessionIds: ["one", "two"] };

  await new LocalCollector({ providers: [provider], storage }).scanForChanges(selection);

  assert.equal(provider.selections.length, 1);
  assert.equal(provider.selections[0], selection);
  const located = (sessionId: string, path: string) => ({
    source: { harness: "codex", sessionId, streamId: "mock:/mock/" + path }, location: { root: "/mock", path },
  });
  assert.deepEqual(storage.batches.map(({ source, sourceObservation, messages }) => ({
    source, location: sourceObservation?.location, texts: messages.map(message => message.text),
  })), [
    { ...located("one", "chats/one.jsonl"), texts: ["Plan search"] },
    { ...located("one", "chats/one.jsonl"), texts: ["Use an index"] },
    { ...located("two", "chats/two.jsonl"), texts: ["Measure latency"] },
  ]);
});

test("the stream ID is the path of the location with an installation ID, and the root-based stream ID without one", async () => {
  const scan = async (installationId?: string) => {
    const transcript = new MockTranscript("/mock/chats/one.jsonl", "one", ["Plan search"]);
    const provider = new MockScanProvider({ harness: "claude", root: "/mock", groups: [[transcript]] });
    const storage = new RecordingCollectorStorage();
    await new LocalCollector({ providers: [provider], storage, installationId }).scanForChanges();
    return storage.batches.map(batch => batch.source);
  };

  assert.deepEqual(await scan("desktop"), [{ harness: "claude", sessionId: "one", streamId: "chats/one.jsonl", installationId: "desktop" }]);
  assert.deepEqual(await scan(), [{ harness: "claude", sessionId: "one", streamId: "mock:/mock/chats/one.jsonl" }]);
});

test("reads the files of each provider in the order of the providers, then checks their presence in the same order", async () => {
  const journal: string[] = [];
  const first = new MockScanProvider({
    harness: "claude", root: "/first", journal, groups: [[new MockTranscript("/first/one.jsonl", "one", ["Use an index"])]],
  });
  const second = new MockScanProvider({
    harness: "codex", root: "/second", journal, groups: [[new MockTranscript("/second/two.jsonl", "two", ["Plan search"])]],
  });

  await new LocalCollector({ providers: [first, second], storage: new RecordingCollectorStorage({}, journal) }).scanForChanges();

  assert.deepEqual(journal, [
    "openScan /first", "openScan /second",
    "discoverFiles /first", "locate /first", "readCheckpoint claude/one", "parserFor /first", "commit claude/one",
    "discoverFiles /second", "locate /second", "readCheckpoint codex/two", "parserFor /second", "commit codex/two",
    "listSources /first", "recordPresence claude/one",
    "listSources /second", "recordPresence codex/two",
  ]);
});

test("a pass without a logical name, identity repair or earlier copies imports its files and checks their presence", async () => {
  const journal: string[] = [];
  const provider = new MockScanProvider({
    harness: "codex", root: "/mock", journal, groups: [[new MockTranscript("/mock/one.jsonl", "one", ["Plan search"])]],
  });
  const storage = new RecordingCollectorStorage({ acknowledged: [gone] }, journal);

  await new LocalCollector({ providers: [provider], storage }).scanForChanges();

  assert.deepEqual(storage.batches.map(batch => batch.messages.map(message => message.text)), [["Plan search"]]);
  assert.deepEqual(journal, [
    "openScan /mock", "discoverFiles /mock", "locate /mock", "readCheckpoint codex/one", "parserFor /mock", "commit codex/one",
    "listSources /mock", "recordPresence codex/one", "confirmedAbsent /mock",
  ]);
});

test("a pass with identity repair receives the acknowledged sources that it did not see", async () => {
  const journal: string[] = [];
  const provider = new MockScanProvider({
    harness: "codex", root: "/mock", repairs: true, journal, groups: [[new MockTranscript("/mock/one.jsonl", "one", ["Plan search"])]],
  });
  const storage = new RecordingCollectorStorage({ acknowledged: [gone] }, journal);

  await new LocalCollector({ providers: [provider], storage }).scanForChanges();

  assert.equal(provider.repairs.length, 1);
  const [repair] = provider.repairs;
  assert.equal(repair.storage, storage);
  assert.equal(repair.scope.root, "/mock");
  assert.deepEqual([...repair.known.values()], [gone]);
  assert.deepEqual([...repair.seen].map(({ transcript }) => transcript.sessionId), ["one"]);
  assert.deepEqual(journal.slice(6), ["listSources /mock", "recordPresence codex/one", "repairIdentities /mock", "confirmedAbsent /mock"]);
});

test("a format with prepareBatch gets the stored session before its first batch, and a false result skips the batch", async () => {
  const journal: string[] = [];
  const stored: SessionView = { ...ScanPassFixture.storedSession({}), messages: [{ id: "earlier", at: "2026-02-01T12:00:00Z", role: "user", text: "First" }] };
  const format = new PreparingFormat();
  const copy = new MockTranscript("/mock/chat.jsonl.copy", "chat", ["First", "Second"]);
  const provider = new MockScanProvider({ harness: "claude", root: "/mock", format, journal, groups: [[copy]] });
  const storage = new RecordingCollectorStorage({ sessions: [stored] }, journal);

  await new LocalCollector({ providers: [provider], storage }).scanForChanges();

  assert.deepEqual(journal, [
    "openScan /mock", "discoverFiles /mock", "locate /mock", "readCheckpoint claude/chat", "parserFor /mock",
    "readSession claude/chat", "commit claude/chat", "listSources /mock", "recordPresence claude/chat",
  ]);
  assert.deepEqual(format.prepared, [
    { known: stored, expectedOffset: 0, texts: ["First"] },
    { known: stored, expectedOffset: 0, texts: ["Second"] },
  ]);
  assert.equal(format.prepared[0].known, stored);
  assert.deepEqual(storage.batches.map(({ expectedVersion, expectedOffset, checkpoint, messages }) => ({
    expectedVersion, expectedOffset, offset: checkpoint.offset, texts: messages.map(message => message.text),
  })), [{ expectedVersion: 1, expectedOffset: 0, offset: copy.fileSize, texts: ["Second"] }]);
});
