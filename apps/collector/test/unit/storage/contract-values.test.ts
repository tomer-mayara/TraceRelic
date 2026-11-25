import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { ContractValues } from "@tracerelic/collector/storage";

const digest = "0123456789abcdef".repeat(4);
const callId = `call:native:${digest}`;

test("isDigest accepts 64 hexadecimal digits in lower case", () => {
  for (const value of [digest, "0".repeat(64), "9".repeat(64), "a".repeat(64), "f".repeat(64)]) {
    assert.equal(ContractValues.isDigest(value), true, value);
  }
});

test("isDigest rejects text that is not exactly 64 digits of 0-9 and a-f", () => {
  const rejected = {
    "63 digits": digest.slice(1),
    "65 digits": `${digest}0`,
    "an upper-case digit at the start": `A${digest.slice(1)}`,
    "an upper-case digit at the end": `${digest.slice(0, 63)}F`,
    "all digits in upper case": digest.toUpperCase(),
    "a leading space": ` ${digest}`,
    "a trailing newline": `${digest}\n`,
    "the empty string": "",
  };
  for (const [reason, value] of Object.entries(rejected)) {
    assert.equal(ContractValues.isDigest(value), false, reason);
  }
  // One character outside 0-9a-f at the end: g, and the characters next to the ranges 0-9 and a-f.
  for (const character of ["g", "/", ":", "`"]) {
    assert.equal(ContractValues.isDigest(digest.slice(0, 63) + character), false, character);
  }
});

test("isDigest rejects a value that is not a string, also one that converts to the text of a digest", () => {
  for (const value of [42, null, undefined, {}, { toString: () => digest }, [digest]]) {
    assert.equal(ContractValues.isDigest(value), false, inspect(value));
  }
});

test("isNativeCallId accepts call:native: and a digest", () => {
  for (const value of [callId, `call:native:${"0".repeat(64)}`, `call:native:${"f".repeat(64)}`]) {
    assert.equal(ContractValues.isNativeCallId(value), true, value);
  }
});

test("isNativeCallId rejects text that is not exactly call:native: and a digest", () => {
  const rejected = {
    "call: and a digest": `call:${digest}`,
    "no colon after native": `call:native${digest}`,
    "only the prefix": "call:native:",
    "a digest with no prefix": digest,
    "63 digits": `call:native:${digest.slice(1)}`,
    "65 digits": `${callId}0`,
    "an upper-case digit": `call:native:${digest.slice(0, 63)}F`,
    "an upper-case prefix": `CALL:NATIVE:${digest}`,
    "text after the digest": `${callId}:1`,
    "a trailing newline": `${callId}\n`,
    "text before the prefix": ` ${callId}`,
    "the empty string": "",
  };
  for (const [reason, value] of Object.entries(rejected)) {
    assert.equal(ContractValues.isNativeCallId(value), false, reason);
  }
});

test("isNativeCallId rejects a value that is not a string, also one that converts to a native call ID", () => {
  for (const value of [42, null, undefined, {}, { toString: () => callId }, [callId]]) {
    assert.equal(ContractValues.isNativeCallId(value), false, inspect(value));
  }
});
