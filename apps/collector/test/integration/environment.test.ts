import assert from "node:assert/strict";
import { test } from "node:test";
import { harnesses } from "@tracerelic/shared";
import Database from "better-sqlite3";

test("collector can query SQLite with a shared harness ID", (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const row = db.prepare("SELECT ? AS harness").get(harnesses[0]);
  assert.deepEqual(row, { harness: "codex" });
});
