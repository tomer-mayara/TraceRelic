import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { test } from "node:test";
import { LostConnectionFixture } from "../../fixtures/lost-connection-fixture.ts";

test("a readable checkpoint behind the dropped request leaves the upload pending until a fresh scan", async t => {
  const fixture = await LostConnectionFixture.create();
  t.after(() => fixture.close());
  await fixture.prepare(120, 30);
  const { connection, transcript } = fixture;
  connection.dropNextWrite("before storage writes", false);
  await assert.rejects(transcript.scan(connection), error => {
    assert(error instanceof Error && "pending" in error);
    assert.partialDeepStrictEqual(error.pending, { status: "pending", reason: "storage-unavailable" });
    return true;
  });
  await fixture.checkStored(1, 120);
  assert.equal(connection.writes, 2);
  await transcript.scan(connection);
  await fixture.checkStored(2, 150);
  assert.equal(connection.writes, 3);
});

test("a readable checkpoint confirms the lost reply and the same scan imports the remaining batch once", async t => {
  const fixture = await LostConnectionFixture.create();
  t.after(() => fixture.close());
  await fixture.prepare(120, 30);
  const { connection, transcript } = fixture;
  // A record larger than the default batch keeps the third call out of the lost reply's batch.
  await transcript.append({ ...transcript.call("third", 10), padding: "x".repeat(256 * 1024) });
  const end = (await stat(transcript.file)).size;
  connection.dropNextWrite("after storage writes", false);
  const session = await transcript.scan(connection);
  assert.equal(session.coverage, "reported");
  assert.equal(session.observedTotalTokens, 160);
  assert.deepEqual(session.usage.map(row => row.inputTokens).sort((a, b) => a - b), [10, 30, 120]);
  assert.equal(new Set(session.usage.map(row => row.id)).size, 3);
  const accepted = await fixture.storage.readCheckpoint(transcript.source);
  assert.equal(accepted.checkpoint?.offset, end);
  assert.equal(accepted.version, 3);
  assert.deepEqual(await transcript.scan(connection), session);
  assert.equal(connection.writes, 3);
});
