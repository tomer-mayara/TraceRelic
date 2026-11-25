import assert from "node:assert/strict";
import { test } from "node:test";
import { TextOccurrences } from "#src/scan/parser-state";

const digest = "0123456789abcdef".repeat(4);

test("restores the saved count of each text digest", () => {
  const saved = { [digest]: 1, ["f".repeat(64)]: Number.MAX_SAFE_INTEGER };
  assert.deepEqual(TextOccurrences.restore(saved).snapshot(), saved);
});

test("rejects a saved text occurrence whose key is not a digest or whose count is not a safe integer of one or more", () => {
  for (const state of [{ private: 1 }, { [digest.toUpperCase()]: 1 }, { [digest.slice(1)]: 1 },
    { [digest]: 0 }, { [digest]: 1.5 }, { [digest]: "2" }, { [digest]: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => TextOccurrences.restore(state), { name: "Error", message: "Invalid chat parser state" });
  }
});
