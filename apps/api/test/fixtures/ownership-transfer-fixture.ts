import assert from "node:assert/strict";
import { Client } from "pg";
import type { CollectorStorage, SourceScope } from "@tracerelic/collector/storage";
import { call, child, original, ownChild, parent } from "#collector-fixture/claude-ownership-storage-fixture";
import { batch, planning } from "#collector-fixture/collector-storage-fixture";

const scope: SourceScope = { harness: "claude", installationId: "desktop", root: "/history/claude" };
const childSource = { ...child, installationId: "desktop" };
const childFile = { location: { root: scope.root, path: child.streamId }, observedEnd: 10 };
const parentFile = { location: { root: scope.root, path: parent.streamId }, observedEnd: 20 };
const sharedCall = call("shared", "shared-request", 100, { ...ownChild, sourceOrder: 1, byteRange: original.byteRange });
const independent = call("child-only", "child-request", 25, { ...ownChild, transcriptUuid: "child-only" });
const childBatch = batch(0, 0, {
  source: childSource, sourceObservation: childFile, metadata: { parentSessionId: parent.sessionId },
  messages: [{ ...planning, text: "The child's original text" }], claudeUsageReports: [sharedCall, independent],
});
const parentBatch = batch(0, 0, {
  source: parent, sourceObservation: parentFile, messages: [{ ...planning, text: "The parent's original text", sourceOrder: 1 }],
});

export const parentClaim = batch(2, 10, {
  source: parent, sourceObservation: parentFile, checkpoint: { offset: 20, parserState: "parent with call" },
  messages: [{ ...planning, id: "parent-claim", text: "The parent claims the call", sourceOrder: 2 }],
  claudeUsageReports: [call("shared", "shared-request", 100, { ...original, sourceOrder: 2, byteRange: { startOffset: 10, endOffset: 15 } })],
});

export async function seedOwnershipTransfer(store: CollectorStorage): Promise<void> {
  assert.equal(await store.commit(parentBatch), "committed");
  assert.equal(await store.commit(childBatch), "committed");
  assert.equal(await store.recordPresence({ source: parent, ...parentFile, expectedVersion: 1, expectedOffset: 10,
    presence: "missing" }), "committed");
}

export async function readOwnershipTransfer(store: CollectorStorage) {
  const [childView, parentView, childCheckpoint, parentCheckpoint, sources] = await Promise.all([
    store.readSession(childSource), store.readSession(parent), store.readCheckpoint(childSource), store.readCheckpoint(parent),
    store.listSources(scope),
  ]);
  assert(childView && parentView);
  return { child: childView, parent: parentView, childCheckpoint, parentCheckpoint, sources };
}

/** Fail at COMMIT, after PostgreSQL has applied the journal, both sessions and the source update. */
export async function interruptRecordCommit(databaseUrl: string, store: CollectorStorage) {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query(`CREATE FUNCTION tracerelic_collector.interrupt_record_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Simulated failure after record insert' USING ERRCODE = '40001'; END;
      $$;
      CREATE CONSTRAINT TRIGGER interrupt_record_commit AFTER INSERT ON tracerelic_collector.records
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.kind = 'message')
        EXECUTE FUNCTION tracerelic_collector.interrupt_record_commit()`);
    try {
      return await store.commit(parentClaim);
    } finally {
      await client.query(`DROP TRIGGER interrupt_record_commit ON tracerelic_collector.records;
        DROP FUNCTION tracerelic_collector.interrupt_record_commit()`);
    }
  } finally {
    await client.end();
  }
}
