import assert from "node:assert/strict";
import { test } from "node:test";
import type { Batch, SessionView } from "../../../src/storage/collector-storage.ts";
import { ClaudeUsageScanFixture } from "../../fixtures/claude-usage-scan-fixture.ts";

test("a competing collector can finish this source while its correction is being retried", async t => {
  const fixture = await ClaudeUsageScanFixture.create();
  t.after(() => fixture.close());
  const base = fixture.report(1, { input_tokens: 10, output_tokens: 2 });
  const final = fixture.report(2, { input_tokens: 10, output_tokens: 9 }, { final: true });
  await fixture.append("desktop", final);
  await fixture.append("laptop", base);
  const commit = fixture.storage.commit.bind(fixture.storage);
  const competitors = ["laptop", "desktop"] as const;
  let races = 0;
  let competing = false;
  let winner: SessionView | undefined;
  t.mock.method(fixture.storage, "commit", async (batch: Batch) => {
    if (!competing && races < competitors.length) {
      competing = true;
      winner = await fixture.scan(competitors[races++]);
      competing = false;
    }
    return commit(batch);
  });
  const result = await fixture.scan("desktop");
  assert.equal(races, 2);
  assert.equal(result.observedTotalTokens, 19);
  assert.deepEqual(result, winner);
  assert.deepEqual(await fixture.scan("desktop"), result);
});
