import assert from "node:assert/strict";
import { test } from "node:test";
import { batch, codexMeasurement, codexSource, observation, prompt } from "#collector-fixture/collector-storage-fixture";
import { call, child, original, ownChild, parent } from "#collector-fixture/claude-ownership-storage-fixture";
import { inventoryLocation, inventoryScope, inventorySource, measuredSource, presence } from "#collector-fixture/source-inventory-fixture";
import { DurableParityFixture } from "../../fixtures/durable-parity-fixture.ts";

test("a fresh connection reads ordered messages, corrected usage and each installation's source status", async t => {
  const fixture = await DurableParityFixture.open(t);
  const desktop = inventorySource;
  const laptop = { ...desktop, installationId: "laptop" };
  const extraStream = { ...desktop, streamId: "rollout-earlier-name.jsonl" };
  const otherSession = { ...desktop, sessionId: "alphabetically-first" };
  const otherProvider = { ...desktop, harness: "claude" } as const;
  const first = { ...prompt("retained\u0000text 😀\ud800"), id: "first\u0000part", sourceOrder: 3 };
  const last = { ...prompt("last"), id: "last", sourceOrder: 7 };
  await fixture.commit({ ...measuredSource(500), messages: [last, first] });
  await fixture.commit({ ...measuredSource(), source: otherSession });
  await fixture.commit(batch(0, 0, { source: otherProvider, messages: [{ ...first, text: "Claude" }], usage: [observation(2, 1)] }));
  await fixture.commit(batch(1, 0, { source: extraStream,
    sourceObservation: { location: { ...inventoryLocation, path: extraStream.streamId }, observedEnd: 10 } }));
  const corrected = observation(90, 9, 2);
  await fixture.commit(batch(2, 0, { source: laptop, checkpoint: { offset: 70, parserState: "laptop" },
    sourceObservation: { location: inventoryLocation, observedEnd: 70 }, usage: [corrected] }));
  assert.equal(await fixture.compare(store => store.recordPresence(presence(3, "missing", 500))), "committed");

  await fixture.reconnect();
  const session = await fixture.compare(store => store.readSession(desktop));
  assert.deepEqual(session?.messages, [first, last]);
  assert.deepEqual(session?.usage, [corrected]);
  assert.equal(session?.observedTotalTokens, 99);
  assert.equal(session?.coverage, "partial");
  assert.deepEqual(session?.missingSources, [{ status: "missing", source: desktop, acceptedOffset: 420, observedEnd: 500 }]);
  const claude = await fixture.compare(store => store.readSession(otherProvider));
  assert.deepEqual(claude?.messages, [{ ...first, text: "Claude" }]);
  assert.equal(claude?.observedTotalTokens, 3);
  const inventory = await fixture.compare(store => store.listSources(inventoryScope));
  assert.deepEqual(inventory.map(row => row.source), [desktop, extraStream, otherSession]);
  const [seen] = await fixture.compare(store => store.listSources({ ...inventoryScope, installationId: "laptop" }));
  assert.deepEqual([seen.source, seen.presence, seen.acceptedOffset], [laptop, "present", 70]);
  assert.equal(await fixture.compare(store => store.recordPresence(presence(4, "missing", 500))), "committed");
  assert.deepEqual(await fixture.compare(store => store.readCheckpoint(desktop)),
    { version: 4, checkpoint: measuredSource().checkpoint, observedThrough: { offset: 500 } });
  assert.deepEqual(await fixture.compare(store => store.readCheckpoint(laptop)), { version: 4, checkpoint: { offset: 70, parserState: "laptop" } });
  const current = observation(5, 4, 3);
  await fixture.commit(batch(4, 70, { source: laptop, usage: [current] }));
  await fixture.reconnect();
  assert.deepEqual((await fixture.compare(store => store.readSession(desktop)))?.usage, [current]);
  assert.equal((await fixture.compare(store => store.readCheckpoint(desktop))).checkpoint?.offset, 420);
  assert.equal((await fixture.compare(store => store.readCheckpoint(laptop))).checkpoint?.offset, 80);
});

test("late Codex fork evidence moves the call in one workspace across a restart", async t => {
  const fixture = await DurableParityFixture.open(t);
  const fork = { ...codexSource, sessionId: "child" };
  const origin = { ...codexSource, sessionId: "parent" };
  const saved = { offset: 20, parserState: "unresolved", prefixDigest: "a".repeat(64),
    codexFork: { parentSessionId: origin.sessionId, firstUncertain: { lineNumber: 2, offset: 9 } } };
  const copied = { ...codexMeasurement("child-call", "call", 25), requestId: "provider-request" };
  const own = { ...copied, id: "parent-call" };
  const claim = { providerId: "c".repeat(64), usageId: copied.id, ownerSessionId: fork.sessionId };
  const first = batch(0, 0, { source: fork, usage: [copied], checkpoint: saved, codexCallClaims: [claim] });
  const second = batch(0, 0, { source: origin, usage: [own],
    codexCallClaims: [{ ...claim, usageId: own.id, ownerSessionId: origin.sessionId }] });
  for (const workspace of ["main", "other"]) {
    await fixture.commit(first, workspace);
    await fixture.commit(second, workspace);
  }
  await fixture.reconnect();
  assert.deepEqual((await fixture.compare(store => store.readSession(fork)))?.usage, [copied]);
  assert.equal((await fixture.compare(store => store.readSession(origin)))?.observedTotalTokens, null);
  const proven = { ...saved, parserState: "verified", codexFork: { parentSessionId: origin.sessionId,
    inheritedThrough: { lineNumber: 1, offset: 5 }, baseline: { inputTokens: 80, outputTokens: 20 } } };
  await fixture.commit(batch(1, 20, { source: fork, checkpoint: proven, reconcileCodexForkFrom: saved }));
  await fixture.reconnect();
  assert.deepEqual((await fixture.compare(store => store.readSession(fork)))?.usage, []);
  assert.deepEqual((await fixture.compare(store => store.readSession(origin)))?.usage, [own]);
  assert.deepEqual(await fixture.compare(store => store.readCheckpoint(origin)), { version: 2, checkpoint: second.checkpoint });
  assert.deepEqual((await fixture.compare(store => store.readSession(fork), "other"))?.usage, [copied]);
  assert.equal((await fixture.compare(store => store.readSession(origin), "other"))?.observedTotalTokens, null);
  assert.equal((await fixture.compare(store => store.readCheckpoint(origin), "other")).version, 1);
});

test("a Claude parent arriving after restart takes its call and preserves the child's independent usage and damage report", async t => {
  const fixture = await DurableParityFixture.open(t);
  const copied = call("shared", "provider-request", 100, { ...ownChild, sourceOrder: 1, byteRange: original.byteRange });
  const independent = call("other", "child-request", 25, { ...ownChild, transcriptUuid: "child-only" });
  const damage = { code: "malformed-transcript-line", sourceOrder: 3, byteRange: { startOffset: 7, endOffset: 9 } } as const;
  const initial = batch(0, 0, { source: child, metadata: { parentSessionId: parent.sessionId },
    claudeUsageReports: [copied, independent], usageDiagnostics: [damage] });
  await fixture.commit(initial);
  await fixture.reconnect();
  assert.equal((await fixture.compare(store => store.readSession(child)))?.observedTotalTokens, 125);
  await fixture.commit(batch(0, 0, { source: parent, claudeUsageReports: [call("shared", "provider-request", 100, original)] }));
  await fixture.reconnect();
  const remaining = await fixture.compare(store => store.readSession(child));
  assert.equal(remaining?.observedTotalTokens, 25);
  assert.equal(remaining?.coverage, "partial");
  assert.deepEqual(remaining?.usageDiagnostics, [{ ...damage, streamId: child.streamId, installationId: child.installationId }]);
  assert.equal((await fixture.compare(store => store.readSession(parent)))?.observedTotalTokens, 100);
  assert.deepEqual(await fixture.compare(store => store.readCheckpoint(child)), { version: 2, checkpoint: initial.checkpoint });
});
