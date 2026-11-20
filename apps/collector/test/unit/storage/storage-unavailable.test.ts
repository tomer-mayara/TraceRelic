import assert from "node:assert/strict";
import { test } from "node:test";
import { StorageAuthenticationError, StorageBackoffError, StorageUnavailableError } from "#src/storage/collector-storage";

test("recognizes storage connection failures and timeouts", () => {
  assert(StorageUnavailableError.is(new StorageUnavailableError()));
  for (const code of ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE"]) {
    assert(StorageUnavailableError.is(Object.assign(new Error("transport detail"), { code })), code);
  }
  const timeout = new DOMException("deadline exceeded", "TimeoutError");
  assert(StorageUnavailableError.is(timeout));
  for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]) {
    const cause = Object.assign(new Error("transport detail"), { code });
    assert(StorageUnavailableError.is(new TypeError("fetch failed", { cause })), code);
  }
});

test("preserves authentication and programming errors even when their message mentions a connection", () => {
  for (const error of [null, "ECONNRESET", new TypeError("connection timed out"),
    Object.assign(new Error("connection refused"), { code: "EACCES" })]) {
    assert.equal(StorageUnavailableError.is(error), false);
  }
});

test("a server delay is temporary and a rejected credential requires the caller to act", () => {
  for (const [hint, expected] of [[undefined, 1000], [0, 1000], [5000, 5000]] as const) {
    const delayed = new StorageBackoffError(hint);
    assert(StorageUnavailableError.is(delayed));
    assert.equal(delayed.retryAfterMs, expected);
  }
  const rejected = new StorageAuthenticationError();
  assert.match(rejected.message, /credential/i);
  assert.equal(StorageUnavailableError.is(rejected), false);
});
