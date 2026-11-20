import assert from "node:assert/strict";
import { test } from "node:test";
import { StorageUnavailableError } from "#src/storage/collector-storage";

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
