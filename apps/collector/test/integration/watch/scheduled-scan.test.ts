import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { test } from "node:test";
import { ScanActivity } from "#src/watch/scan-activity";
import { ScanRejectedError } from "#src/scan/scan-rejected";
import { ScheduledScanner } from "#src/watch/scheduled-scanner";
import { captureCollectorStderr } from "../../fixtures/capture-collector-cli.ts";
import { collectorLogMessage } from "../../fixtures/collector-log-message.ts";
import { batch, planning, source } from "../../fixtures/collector-storage-fixture.ts";
import { RejectedBatchFixture } from "../../fixtures/rejected-batch-fixture.ts";
import { RejectingBatchStorage } from "../../fixtures/rejecting-batch-storage.ts";
import { ScanCommandFixture } from "../../fixtures/scan-command-fixture.ts";
import { ScheduledScanFixture } from "../../fixtures/scheduled-scan-fixture.ts";

test("a final rejection report preserves a repair already accepted during the pass", async () => {
  const storage = new RejectingBatchStorage(write => !write.messages.length);
  const activity = new ScanActivity(storage, () => 0);
  const stop = new AbortController();
  const scan = async () => {
    const first = batch(0, 0);
    assert.equal(await activity.commit(first), "invalid");
    assert.equal(await activity.commit({ ...first, messages: [planning] }), "committed");
    throw new ScanRejectedError([], [ScanRejectedError.batch(source, { startOffset: 0, endOffset: first.checkpoint.offset })]);
  };
  await new ScheduledScanner(scan, activity).run({ intervalMs: 100, signal: stop.signal, onReport: report => {
    stop.abort();
    assert.deepEqual(report, { status: "rejected", newSessions: 1, oldestPendingAgeMs: null });
  } });
});

test("watch keeps its configured roots and project selection between scans", async t => {
  const files = await ScanCommandFixture.create();
  t.after(() => files.close());
  await files.configure();
  await files.writePlanningChat();
  const watch = new ScheduledScanFixture(files.storage, ["--config", files.configFile, "--project", files.projectPath]);
  try {
    await watch.waitForPass();
    assert.deepEqual(watch.reports.map(report => report.newSessions), [0]);
    await writeFile(files.configFile, "{}");
    await files.writeRepeatedClaudePrompt("Evaluate ranking");
    await watch.advance();
    assert.deepEqual(watch.reports[1], { status: "complete", newSessions: 1, oldestPendingAgeMs: null });
    assert.equal(await files.storage.readSession(files.codexKey), null);
    const session = await files.storage.readSession(files.claudeKey);
    assert.deepEqual(session?.messages.map(row => row.text), files.claudeMessages.map(row => row.text));
  } finally {
    await watch.stop();
  }
});

test("watch counts an accepted Claude session and ages the rejected Codex range until its repair", async t => {
  const files = await RejectedBatchFixture.create();
  t.after(() => files.close());
  const { original, byteRange } = await files.prepare("Original", 12);
  const { lines } = captureCollectorStderr(t);
  const [, , ...options] = files.args;
  const watch = new ScheduledScanFixture(files.storage, options);
  try {
    await watch.waitForPass();
    const healthy = await files.storage.readSession(files.b);
    assert.equal(healthy?.observedTotalTokens, 12);
    assert.deepEqual(await files.storage.readSession(files.a), original);
    assert.deepEqual(watch.reports, [{ status: "rejected", newSessions: 1, oldestPendingAgeMs: 0 }]);

    await watch.advance();
    assert.deepEqual(watch.reports[1], { status: "rejected", newSessions: 0, oldestPendingAgeMs: watch.intervalMs });
    assert.deepEqual(lines.map(line => JSON.parse(collectorLogMessage(line, "ERROR"))), Array(2).fill({ status: "rejected", source: files.a, byteRange }));

    const repairedEnd = await files.repair(byteRange.startOffset, "b");
    assert(repairedEnd < byteRange.endOffset);
    await watch.advance();
    assert.deepEqual(watch.reports[2], { status: "complete", newSessions: 0, oldestPendingAgeMs: null });
    assert.deepEqual(await files.storage.readSession(files.b), healthy);
    assert.deepEqual((await files.storage.readSession(files.a))?.messages.map(row => row.text), ["Original", files.changedText]);
  } finally {
    await watch.stop();
  }
});
