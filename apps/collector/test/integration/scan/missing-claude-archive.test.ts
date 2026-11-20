import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { ClaudeProjectFixture as Claude } from "../../fixtures/claude-project-fixture.ts";
import { MissingSourceFixture } from "../../fixtures/missing-source-fixture.ts";

for (const [prefixMatches, extraBytes] of [[true, 0], [true, 80], [false, 80]] as const) {
  test(`a returning Claude archive compares its accepted prefix (match ${prefixMatches}, suffix ${extraBytes})`, async t => {
    const fixture = await MissingSourceFixture.create();
    t.after(() => fixture.close());
    const { claude, args } = await fixture.useClaude();
    const { storage } = fixture.transcript;
    const row = { ...Claude.assistant("chat", "2026-02-01T12:00:00Z", "Kept answer"), uuid: "one", marker: "a" };
    const file = await claude.write("project", "chat", [row]);
    const [before] = await fixture.scan(args);
    const scope = { harness: "claude", installationId: "desktop", root: claude.home } as const;
    const [ack] = await storage.listSources(scope);
    const original = await readFile(file, "utf8");
    const offset = Buffer.byteLength(original);
    const end = offset + extraBytes;
    const suffix = extraBytes ? JSON.stringify({ sessionId: "chat" }).padEnd(extraBytes - 1) + "\n" : "";
    assert.equal(ack.acceptedOffset, offset);
    if (extraBytes) {
      await writeFile(file, original + suffix);
      assert.equal(await storage.recordPresence({ source: ack.source, location: ack.location,
        expectedVersion: ack.version, expectedOffset: offset, presence: "present", observedEnd: end }), "committed");
    }
    await rm(file);
    const [missing] = await fixture.scan(args);
    assert.equal(missing.coverage, extraBytes ? "partial" : "reported");
    assert.equal(missing.missingSources?.length, 1);

    const prefix = prefixMatches ? original : original.replace('"marker":"a"', '"marker":"b"');
    await writeFile(file + ".superseded-123", prefix + suffix);
    const [returned] = await fixture.scan(args);
    const sources = await storage.listSources(scope);
    const current = sources.find(s => s.source.streamId === ack.source.streamId);
    const archive = sources.find(s => s.source.streamId.endsWith(".superseded-123"));
    assert.equal(archive?.acceptedOffset, end);
    assert.equal(current?.presence, prefixMatches ? "present" : "missing");
    assert.equal(current.acceptedOffset, prefixMatches ? end : offset);
    assert.equal(returned.coverage, prefixMatches ? "reported" : "partial");
    assert.deepEqual(returned.missingSources ?? [], prefixMatches ? [] : missing.missingSources);
    assert.deepEqual(returned.messages, before.messages);
    assert.equal(returned.observedTotalTokens, before.observedTotalTokens);
    assert.deepEqual(await fixture.scan(args), [returned]);
    assert.deepEqual(await storage.listSources(scope), sources);
    assert.equal(fixture.reports.length, 1);
  });
}
