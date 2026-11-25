import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexVisibleText } from "#src/providers/codex/codex-visible-text";

test("a completed item keeps only the text parts whose text is a nonempty string", () => {
  for (const [role, type] of [["assistant", "Text"], ["user", "text"]] as const) {
    const content = [{ type, text: "" }, { type, text: 42 }, { type }, { type, text: "Kept" }];
    assert.deepEqual(CodexVisibleText.completedBlocks(role, { content }), [{ blockIndex: 3, text: "Kept" }]);
  }
});

test("a message keeps only the text blocks whose text is a nonempty string", () => {
  for (const [role, type] of [["assistant", "output_text"], ["user", "input_text"]] as const) {
    const content = [{ type, text: "" }, { type, text: 42 }, { type }, { type, text: "Kept" }];
    assert.deepEqual(CodexVisibleText.blocks(role, false, { content }), [{ text: "Kept", blockIndex: 3 }]);
  }
});
