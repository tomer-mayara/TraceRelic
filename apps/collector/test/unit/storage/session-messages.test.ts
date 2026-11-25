import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionMessages } from "#src/storage/session-messages";
import { batch, planning } from "../../fixtures/collector-storage-fixture.ts";

test("a message origin proves an occurrence only with a digest", () => {
  const messages = [{ ...planning, sourceOrder: 1, blockIndex: 0 }];
  const write = (prefixDigest: string) => batch(0, 0, { messages, messageOrigins: [{ sourceOrder: 1, prefixDigest }] });
  assert.ok(SessionMessages.apply(undefined, write("a".repeat(64)), "stream", 0));
  assert.equal(SessionMessages.apply(undefined, write("not-a-digest"), "stream", 0), null);
});
