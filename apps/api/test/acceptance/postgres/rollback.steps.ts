import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import { StorageBackoffError } from "@tracerelic/collector/storage";
import type { DurableApiFixture, WorkspaceClients } from "../../fixtures/durable-api-fixture.ts";
import { interruptRecordCommit, parentClaim, readOwnershipTransfer, seedOwnershipTransfer } from "../../fixtures/ownership-transfer-fixture.ts";

interface RollbackScenario {
  api: DurableApiFixture;
  clients: WorkspaceClients;
  beforeTransfer: Awaited<ReturnType<typeof readOwnershipTransfer>>;
}

Given("a child session owns a call that a parent batch can claim", async function (this: RollbackScenario) {
  await seedOwnershipTransfer(this.clients.a);
  const before = await readOwnershipTransfer(this.clients.a);
  this.beforeTransfer = before;
  assert.deepEqual(before.child.messages.map(row => row.text), ["The child's original text"]);
  assert.deepEqual(before.parent.messages.map(row => row.text), ["The parent's original text"]);
  assert.deepEqual(before.child.usage.map(row => row.requestId), ["shared-request", "child-request"]);
  assert.equal(before.child.observedTotalTokens, 125);
  assert.deepEqual(before.parent.usage, []);
  assert.equal(before.parent.observedTotalTokens, null);
  assert.equal(before.parent.coverage, "unknown");
  assert.deepEqual(before.parent.missingSources, [{ status: "missing", source: parentClaim.source, acceptedOffset: 10, observedEnd: 20 }]);
  assert.deepEqual(before.childCheckpoint, { version: 1, checkpoint: { offset: 10, parserState: "{}" } });
  assert.deepEqual(before.parentCheckpoint, { version: 2, checkpoint: { offset: 10, parserState: "{}" } });
  assert.deepEqual(before.sources.map(row => [row.source.sessionId, row.presence]), [["parent", "missing"], ["child", "present"]]);
});

When("a temporary database error interrupts the parent batch after records have been written", async function (this: RollbackScenario) {
  await assert.rejects(interruptRecordCommit(this.api.databaseUrl, this.clients.a), StorageBackoffError);
});

Then("a fresh reader sees the original text, usage, ownership, source state and versions", async function (this: RollbackScenario) {
  assert.deepEqual(await readOwnershipTransfer((await this.api.start()).a), this.beforeTransfer);
});

When("the writer retries the parent batch once from its old checkpoint", async function (this: RollbackScenario) {
  assert.equal(await this.clients.a.commit(parentClaim), "committed");
});

Then("a fresh reader sees the new text and source state and counts the call once for its parent", async function (this: RollbackScenario) {
  const after = await readOwnershipTransfer((await this.api.start()).a);
  const before = this.beforeTransfer;
  assert.deepEqual(after.parent.messages, [...before.parent.messages, ...parentClaim.messages]);
  assert.deepEqual(after.child.messages, before.child.messages);
  assert.deepEqual(after.parent.usage.map(row => [row.requestId, row.inputTokens]), [["shared-request", 100]]);
  assert.deepEqual(after.child.usage, before.child.usage.filter(row => row.requestId === "child-request"));
  assert.deepEqual([after.parent.observedTotalTokens, after.child.observedTotalTokens], [100, 25]);
  assert.equal(after.parent.coverage, "reported");
  assert.deepEqual(after.parent.missingSources ?? [], []);
  assert.deepEqual(after.parentCheckpoint, { version: 3, checkpoint: parentClaim.checkpoint });
  assert.deepEqual(after.childCheckpoint, { ...before.childCheckpoint, version: 2 });
  assert.deepEqual(after.sources, before.sources.map(row => row.source.sessionId === parentClaim.source.sessionId
    ? { ...row, presence: "present", version: 3, acceptedOffset: 20 } : { ...row, version: 2 }));
});

Then("the API reports a temporary storage failure and a successful retry", async function (this: RollbackScenario) {
  for (const outcome of ["committed", "committed", "storage-unavailable", "committed"]) {
    const { durationMs, ...event } = await this.clients.nextCommitMetric();
    assert(Number.isFinite(durationMs) && durationMs >= 0);
    assert.deepEqual(event, { operation: "commit", workspaceId: "workspace-a", installationId: "desktop", outcome });
  }
});
