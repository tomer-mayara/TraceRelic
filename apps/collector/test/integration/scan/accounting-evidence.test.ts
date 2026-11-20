import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeUsageScanFixture } from "../../fixtures/claude-usage-scan-fixture.ts";
import { CodexForkScanFixture } from "../../fixtures/codex-fork-scan-fixture.ts";
import { CodexUsageScanFixture } from "../../fixtures/codex-usage-scan-fixture.ts";

const at = (second: number) => new Date(Date.UTC(2026, 1, 1, 12, 0, second)).toISOString();
const counts = (input_tokens: number) => ({ input_tokens, output_tokens: 0 });
function legacy(second: number, last: number, total?: number, call_id?: string, request_id?: string) {
  return { timestamp: at(second), type: "event_msg", payload: { type: "token_count", call_id, request_id,
    info: { last_token_usage: counts(last), total_token_usage: total === undefined ? undefined : counts(total) } } };
}
function native(second: number, owner: string, id: string, amount: number, total?: number) {
  return { timestamp: at(second), type: "token_usage_record", payload: { thread_id: owner, turn_id: "turn-" + owner, response_id: id,
    usage: counts(amount), thread_token_usage: total === undefined ? undefined : counts(total) } };
}

for (const nativeFirst of [false, true]) {
  test(`a named legacy last call and native response agree at their common counter boundary (native first ${nativeFirst})`, async t => {
    for (const copies of [false, true]) {
      const f = await CodexUsageScanFixture.create(); t.after(() => f.close());
      const response = native(2, f.key.sessionId, "response", 12, 12);
      const old = legacy(1, 12, 12, "legacy-call", "legacy-request");
      await f.append("desktop", nativeFirst ? response : old);
      const first = await f.scan("desktop");
      const site = copies ? "laptop" : "desktop";
      await f.append(site, nativeFirst ? old : response);
      const updated = await f.scan(site);
      assert.equal(updated.coverage, "reported");
      assert.equal(updated.observedTotalTokens, 12);
      assert.equal(updated.usage.length, 1);
      assert.partialDeepStrictEqual(updated.usage[0], { id: first.usage[0].id, at: first.usage[0].at,
        requestId: "legacy-request", responseId: "response" });
      assert.deepEqual(await f.scan(site), updated);
    }
  });
  test(`a native response and its legacy mirror survive a restart in either order (native first ${nativeFirst})`, async t => {
    const f = await CodexUsageScanFixture.create(); t.after(() => f.close());
    const response = native(2, f.key.sessionId, "r1", 12, 12);
    const old = legacy(1, 12, 12);
    await f.append("desktop", nativeFirst ? response : old);
    const first = await f.scan("desktop");
    await f.append("desktop", nativeFirst ? old : response, response);
    const updated = await f.scan("desktop");
    assert.equal(updated.observedTotalTokens, 12);
    assert.equal(updated.coverage, "reported");
    assert.equal(updated.usage.length, 1);
    assert.equal(updated.usage[0].responseId, "r1");
    assert.equal(updated.usage[0].id, first.usage[0].id);
    assert.equal(updated.usage[0].at, first.usage[0].at);
    assert.deepEqual(await f.scan("desktop"), updated);
  });

  test(`two calls can share a request without a third measurement (weak ID first ${nativeFirst})`, async t => {
    const f = await CodexUsageScanFixture.create(); t.after(() => f.close());
    await f.append("desktop", legacy(1, 10, undefined, undefined, "request"));
    await f.append("laptop", legacy(2, 10, undefined, "first", "request"), legacy(3, 15, undefined, "second", "request"));
    for (const site of nativeFirst ? ["desktop", "laptop"] as const : ["laptop", "desktop"] as const) await f.scan(site);
    const view = await f.scan("desktop");
    assert.deepEqual(view.usage.map(row => row.inputTokens).sort((a, b) => a - b), [10, 15]);
    assert.equal(view.coverage, "partial");
    assert.equal(view.usageDiagnostics?.[0].code, "ambiguous-codex-call");
    assert(view.usageDiagnostics?.[0].byteRange);
  });
}

test("a native response owns its thread even when the parent is discovered later or alone", async t => {
  for (const archived of ["child", "parent"] as const) {
    const f = await CodexForkScanFixture.create(archived); t.after(() => f.close());
    const parent = native(1, "parent", "parent-response", 120, 120);
    await f.writeNative("parent", [parent]);
    await f.writeNative("child", [parent, native(4, "child", "child-response", 25, 145)]);
    const [alone] = await f.scan("child");
    assert.deepEqual(alone.usage.map(row => row.responseId), ["child-response"]);
    assert.equal(alone.observedTotalTokens, 25);
    assert.equal(alone.coverage, "reported");
    const views = await f.scan();
    for (const view of views) {
      assert.equal(view.coverage, "reported");
      assert.deepEqual(view.usage.map(row => row.responseId), [view.key.sessionId + "-response"]);
      assert.equal(view.observedTotalTokens, view.key.sessionId === "parent" ? 120 : 25);
    }
    assert.deepEqual(await f.scan(), views);
  }
});

test("a positional advisor shared by different native advisors stays unresolved", async t => {
  const f = await ClaudeUsageScanFixture.create(); t.after(() => f.close());
  const report = (second: number, id?: string) => f.report(second, { input_tokens: 8, output_tokens: 2,
    iterations: [{ type: "advisor_message", id, input_tokens: 4, output_tokens: 2 }] }, { uuid: "row-" + second, final: true });
  await f.append("desktop", report(1), report(2, "alpha"), report(3, "beta"));
  const view = await f.scan("desktop");
  assert.equal(view.observedTotalTokens, 22);
  assert.deepEqual(view.usage.map(row => row.iterationId).filter(Boolean).sort(), ["native:alpha", "native:beta"]);
  assert.equal(view.coverage, "partial");
  assert.partialDeepStrictEqual(view.usageDiagnostics?.[0], { code: "ambiguous-claude-iteration", sourceOrder: 1 });
  assert(view.usageDiagnostics?.[0].byteRange);
  assert.deepEqual(await f.scan("desktop"), view);
});

test("disagreeing request IDs keep one specific call and surface its disputed attribution", async t => {
  const f = await CodexUsageScanFixture.create(); t.after(() => f.close());
  await f.append("desktop", legacy(1, 10, undefined, "call", "first-request"));
  await f.scan("desktop");
  await f.append("laptop", legacy(2, 10, undefined, "call", "other-request"));
  const result = await f.scan("laptop");
  assert.equal(result.observedTotalTokens, 10);
  assert.equal(result.usage.length, 1);
  assert.equal(result.usage[0].requestId, undefined);
  assert.equal(result.coverage, "partial");
  assert.equal(result.usageDiagnostics?.[0].code, "ambiguous-codex-call");
  assert.deepEqual(await f.scan("desktop"), result);
});

test("two distinct response IDs survive inconsistent thread counters without becoming one call", async t => {
  for (const copies of [true, false]) {
    const f = await CodexUsageScanFixture.create(); t.after(() => f.close());
    await f.append("desktop", native(1, f.key.sessionId, "first", 10, 10));
    await f.scan("desktop");
    const site = copies ? "laptop" : "desktop";
    await f.append(site, native(2, f.key.sessionId, "other", 10, 10));
    const view = await f.scan(site);
    assert.deepEqual(view.usage.map(row => row.responseId).sort(), ["first", "other"]);
    assert.equal(view.observedTotalTokens, 20);
    assert.equal(view.coverage, "partial");
    assert.deepEqual(await f.scan(site), view);
  }
});
