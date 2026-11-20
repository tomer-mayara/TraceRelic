import assert from "node:assert/strict";
import { test } from "node:test";
import { CollectorCommand } from "@tracerelic/collector/command";
import { StorageAuthenticationError } from "@tracerelic/collector/storage";
import { ClaudeProjectFixture as Claude } from "#collector-fixture/claude-project-fixture";
import { ManualScanClock } from "#collector-fixture/manual-scan-clock";
import { MissingSourceFixture } from "#collector-fixture/missing-source-fixture";
import { RemoteSyncFixture } from "../../fixtures/remote-sync-fixture.ts";

for (const terminal of [false, true]) {
  test(`concurrent HTTP checkpoint failures respect the received deadlines and credentials (terminal: ${terminal})`, async t => {
    const sync = await RemoteSyncFixture.open();
    t.after(() => sync.close());
    const files = await MissingSourceFixture.create();
    t.after(() => files.close());
    const { claude, args } = await files.useClaude();
    await claude.write("project", "mixed", ["a", "b"].map(id => Claude.user(id, "2026-02-01T12:00:00Z", "Chat")));
    const command = new CollectorCommand(sync.httpStorage());
    const replies = [{ status: 429, seconds: 1 }, terminal ? { status: 401 } : { status: 429, seconds: 60 }];
    sync.relay.rejectCheckpoints(replies);
    const clock = new ManualScanClock(0);
    const controller = new AbortController();
    const reports: { status: string; retryAt?: string; newSessions: number }[] = [];
    const run = command.run(["watch", "--interval-ms", "10000", ...args.slice(2)], {
      signal: controller.signal, clock, onReport: r => reports.push(r),
    });
    if (terminal) {
      await assert.rejects(run, StorageAuthenticationError);
      assert.deepEqual(reports.map(r => r.status), ["failed"]);
    } else {
      try {
        await clock.whenWaiting();
        assert.equal(reports[0].retryAt, "1970-01-01T00:01:00.000Z");
        clock.advance(59_999);
        assert.equal(reports.length, 1);
        clock.advance(1);
        await clock.whenWaiting();
        assert.equal(reports[1].newSessions, 2);
        clock.advance(10_000);
        await clock.whenWaiting();
        assert.equal(reports[2].newSessions, 0);
        assert.equal(sync.relay.sessionReads, 0);
        const views = await command.run(args);
        assert.equal(views.length, 2);
        assert.equal(sync.relay.sessionReads, 2);
      } finally { controller.abort(); await run; }
    }
    assert.deepEqual(sync.relay.checkpointReplies, replies);
  });
}
