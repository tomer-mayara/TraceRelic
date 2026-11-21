import assert from "node:assert/strict";
import { test } from "node:test";
import type { Batch } from "../../../src/storage/collector-storage.ts";
import { captureCollectorCli } from "../../fixtures/capture-collector-cli.ts";
import { collectorLogMessage } from "../../fixtures/collector-log-message.ts";
import { RejectedBatchFixture } from "../../fixtures/rejected-batch-fixture.ts";

test("the CLI prints accepted sessions and identifies the rejected batch on standard error", async t => {
  const fixture = await RejectedBatchFixture.create();
  t.after(() => fixture.close());
  const { original, byteRange } = await fixture.prepare("Original", 12);
  const { code, stdout, stderr } = await captureCollectorCli(t, fixture.args, fixture.storage);
  assert.equal(code, 1);
  assert.equal(stdout.length, 1);
  const b = await fixture.storage.readSession(fixture.b);
  assert.equal(b?.observedTotalTokens, 12);
  assert.deepEqual(JSON.parse(stdout[0]), [original, b]);
  assert.deepEqual(stderr.map(line => JSON.parse(collectorLogMessage(line, "ERROR"))), [{ status: "rejected", source: fixture.a, byteRange }]);
});

for (const outcome of ["invalid", "timeout"] as const) {
  test(`a later ${outcome} preserves the earlier rejected range in CLI output`, async t => {
    const fixture = await RejectedBatchFixture.create();
    t.after(() => fixture.close());
    const { original, byteRange } = await fixture.prepare("Original", 12);
    const commit = fixture.storage.commit.bind(fixture.storage);
    t.mock.method(fixture.storage, "commit", async (batch: Batch) => {
      if (batch.source.harness === "codex") return commit(batch);
      if (outcome === "invalid") return "invalid";
      throw Object.assign(new Error("private transport detail"), { code: "ETIMEDOUT" });
    });
    const { code, stdout, stderr } = await captureCollectorCli(t, fixture.args, fixture.storage);
    assert.equal(stderr.length, 2);
    const first = JSON.parse(collectorLogMessage(stderr[0], "ERROR"));
    const second = JSON.parse(collectorLogMessage(stderr[1], outcome === "invalid" ? "ERROR" : "WARN"));
    assert.deepEqual(first, { status: "rejected", source: fixture.a, byteRange });
    assert.deepEqual(second.source, fixture.b);
    assert.equal(second.byteRange.startOffset, 0);
    assert(second.byteRange.endOffset > 0);
    assert.doesNotMatch(stderr.join("\n"), /Original|Changed private text|Private healthy reply|private transport detail/);
    if (outcome === "invalid") {
      assert.equal(code, 1);
      assert.equal(second.status, "rejected");
      assert.deepEqual(stdout.map(line => JSON.parse(line)), [[original]]);
    } else {
      assert.equal(code, 75);
      assert.equal(second.status, "pending");
      assert.equal(second.reason, "storage-unavailable");
      assert.deepEqual(stdout, []);
    }
  });
}
