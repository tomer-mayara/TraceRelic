import assert from "node:assert/strict";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { collectorLogMessage } from "#collector-fixture/collector-log-message";
import { RemoteSyncFixture } from "../../fixtures/remote-sync-fixture.ts";

test("a scanner without a configured installation recognizes its credential's acknowledged source after restart", async t => {
  const sync = await RemoteSyncFixture.open();
  t.after(() => sync.close());
  const { transcript, storage } = sync.upload;
  const root = transcript.root.home;
  const config = join(root, "implicit-installation.json");
  await writeFile(config, JSON.stringify({ codexPath: root }));
  await transcript.write([transcript.call("first", 120)]);

  const session = await sync.scanAndRead(config);
  assert.equal(session.observedTotalTokens, 120);
  const inventory = await storage.listSources({ harness: "codex", root });
  assert.equal(inventory.length, 1);
  const [row] = inventory;
  assert.equal(row.source.installationId, "desktop");
  assert.equal(row.presence, "present");
  assert.deepEqual(await sync.scanAndRead(config), session);
  assert.equal(sync.relay.presenceWrites, 0, "an unchanged source already has an accepted observation");

  await unlink(transcript.file);
  const result = await sync.scan(config);
  assert.equal(result.code, 0, result.stderr);
  const missing: unknown = JSON.parse(collectorLogMessage(result.stderr, "WARN"));
  const range = { acceptedOffset: row.acceptedOffset, observedEnd: row.observedEnd };
  assert.partialDeepStrictEqual(missing, { status: "missing", source: { streamId: row.source.streamId }, ...range });
  const accepted = await storage.readSession(session.key);
  assert.deepEqual(accepted?.missingSources, [{ status: "missing", source: row.source, ...range }]);
  assert.equal(accepted?.observedTotalTokens, 120);
});
