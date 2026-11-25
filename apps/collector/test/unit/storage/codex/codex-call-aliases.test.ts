import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexCallAliases } from "#src/storage/codex/codex-call-aliases";
import { batch, codexSource } from "../../../fixtures/collector-storage-fixture.ts";

test("an alias row names a native Codex call as its call", () => {
  const write = (callUsageId: string) => batch(0, 0, {
    source: codexSource, codexCallAliases: [{ callUsageId, aliasUsageId: "call:" + "b".repeat(64) }],
  });
  assert.equal(CodexCallAliases.valid(write("call:native:" + "a".repeat(64))), true);
  assert.equal(CodexCallAliases.valid(write("call:" + "a".repeat(64))), false);
});
