import assert from "node:assert/strict";
import { test } from "node:test";
import { CollectorCredentials } from "#src/collector-credentials";
import { credentialRecord } from "../../fixtures/collector-credential.ts";

test("a bearer credential identifies its registered workspace and installation until the expiry instant", () => {
  const token = "Test.again~for+expiry/1==";
  const record = { ...credentialRecord(token), expiresAt: "2028-02-29T03:30:00.050+03:30" };
  let now = Date.parse("2028-02-29T00:00:00.049Z");
  const registry = new CollectorCredentials([record], () => now);
  assert.deepEqual(registry.verify("bEaReR    " + token), { workspaceId: "workspace-a", installationId: "desktop" });
  now++;
  assert.equal(registry.verify("Bearer " + token), null);
});

test("unregistered, malformed and missing credentials give the same empty result", () => {
  const registry = new CollectorCredentials([credentialRecord("sample")]);
  for (const input of [undefined, "", "Bearer", "Bearer   ", "sample", "Basic sample", "Bearer SAMPLE",
    "Bearer sample extra", "Bearer sample, Bearer sample", "Bearer sa=mple", "Bearer sam\nple"]) {
    assert.equal(registry.verify(input), null);
  }
});

test("fractional expiry and a UTC leap second keep their boundary on a millisecond clock", () => {
  for (const [expiresAt, firstExpiredMs] of [
    ["2028-02-29T00:00:00.000001Z", Date.UTC(2028, 1, 29) + 1],
    ["2016-12-31T23:59:60Z", Date.UTC(2017, 0, 1)],
  ] as const) {
    let now = firstExpiredMs - 1;
    const registry = new CollectorCredentials([{ ...credentialRecord("boundary"), expiresAt }], () => now);
    assert(registry.verify("Bearer boundary"));
    now++;
    assert.equal(registry.verify("Bearer boundary"), null);
  }
});

test("one request cannot change the scope used by later requests", () => {
  const record = credentialRecord("example");
  const registry = new CollectorCredentials([record]);
  record.workspaceId = "changed";
  const scope = registry.verify("Bearer example");
  assert(scope);
  scope.installationId = "changed";
  assert.deepEqual(registry.verify("Bearer example"), { workspaceId: "workspace-a", installationId: "desktop" });
});

test("configuration errors reject the registry without including any credential or record data", () => {
  const token = "synthetic-do-not-log";
  const record = credentialRecord(token);
  for (const invalid of [null, {}, [null], [record, { ...record, workspaceId: "workspace-b" }],
    [{ ...record, token }], [{ ...record, tokenSha256: record.tokenSha256.toUpperCase() }], [{ ...record, tokenSha256: token }],
    [{ ...record, workspaceId: "   " }], [{ ...record, installationId: "bad\0id" }],
    [{ ...record, expiresAt: "2027-02-29T00:00:00Z" }], [{ ...record, expiresAt: "2028-01-01" }],
    [{ ...record, expiresAt: "2028-01-01T00:00:00" }], [{ ...record, expiresAt: "2028-01-01T00:00:00+01" }]]) {
    assert.throws(() => new CollectorCredentials(invalid), (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /credential/i);
      assert(!error.message.includes(token) && !error.message.includes(record.tokenSha256));
      return true;
    });
  }
});
