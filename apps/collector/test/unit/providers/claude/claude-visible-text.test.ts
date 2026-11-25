import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeVisibleText } from "#src/providers/claude/claude-visible-text";

test("keeps only the text blocks whose text is a nonempty string", () => {
  const content = [{ type: "text", text: "" }, { type: "text", text: 42 }, { type: "text" }, { type: "text", text: "Kept" }];
  for (const user of [false, true]) {
    assert.deepEqual(ClaudeVisibleText.blocks(content, user), [{ blockIndex: 3, text: "Kept" }]);
    assert.deepEqual(ClaudeVisibleText.blocks("", user), []);
  }
});
