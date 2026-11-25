import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { JsonRecord } from "#src/transcript/json-record";

test("isNonemptyString accepts a string that has one character or more, also one space", () => {
  for (const value of ["a", " "]) {
    assert.equal(JsonRecord.isNonemptyString(value), true, inspect(value));
  }
});

test("isNonemptyString rejects the empty string and each value that is not a string", () => {
  for (const value of ["", 0, null, undefined, [], ["a"], {}]) {
    assert.equal(JsonRecord.isNonemptyString(value), false, inspect(value));
  }
});

test("identifier gives the first value that is a nonempty string", () => {
  assert.equal(JsonRecord.identifier(undefined, "", 7, "b", "c"), "b");
});

test("identifier gives undefined when no value is a nonempty string", () => {
  assert.equal(JsonRecord.identifier("", null), undefined);
});
