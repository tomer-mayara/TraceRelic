import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import type { SessionView } from "../../../src/storage/collector-storage.ts";
import { ClaudeUsageScanFixture } from "../../fixtures/claude-usage-scan-fixture.ts";
import { CodexUsageScanFixture } from "../../fixtures/codex-usage-scan-fixture.ts";

interface EvidenceScenario {
  evidenceViews: SessionView[];
  nativeCase?: boolean;
}

Given("two copies report the same 10-token executor and 6-token advisor", function (this: EvidenceScenario) {
  this.evidenceViews = [];
});

When("the copies are scanned in both orders with an advisor ID in one copy", async function (this: EvidenceScenario) {
  for (const site of ["desktop", "laptop"] as const) {
    const f = await ClaudeUsageScanFixture.create();
    try {
      for (const copy of ["desktop", "laptop"] as const) {
        const advisor = { type: "advisor_message", input_tokens: 4, output_tokens: 2,
          ...(copy === "laptop" && { id: "advisor-a" }) };
        await f.append(copy, f.report(1, { input_tokens: 8, output_tokens: 2, iterations: [advisor] },
          { final: copy === "laptop" }));
      }
      const first = await f.scan(site);
      const view = await f.scan(site === "desktop" ? "laptop" : "desktop");
      assert.deepEqual(await f.scan(site), view);
      assert.equal(view.usage.find(row => row.iterationId)?.id, first.usage.find(row => row.iterationId)?.id);
      this.evidenceViews.push(view);
    } finally { await f.close(); }
  }
});

Then("each session shows 16 tokens and one advisor measurement", function (this: EvidenceScenario) {
  for (const view of this.evidenceViews) {
    assert.equal(view.observedTotalTokens, 16);
    assert.equal(view.coverage, "reported");
    assert.deepEqual(view.usage.filter(row => row.iterationId).map(row => [row.iterationId, row.status]),
      [["native:advisor-a", "final"]]);
  }
});

Given("two copies report a 10-token Codex call and one adds a request ID", function (this: EvidenceScenario) {
  this.evidenceViews = [];
});

Given("a native Codex response and a legacy counter describe the same 120 tokens", function (this: EvidenceScenario) {
  this.nativeCase = true;
  this.evidenceViews = [];
});

When(/the (?:call|native and legacy) reports are scanned in both orders/, async function (this: EvidenceScenario) {
  for (const site of ["desktop", "laptop"] as const) {
    const f = await CodexUsageScanFixture.create();
    try {
      const usage = this.nativeCase ? { input_tokens: 95, output_tokens: 25 } : { input_tokens: 8, output_tokens: 2 };
      const timestamp = "2026-02-01T12:00:00Z";
      for (const copy of ["desktop", "laptop"] as const) {
        const native = this.nativeCase && copy === "laptop";
        const payload = native ? { thread_id: f.key.sessionId, turn_id: "turn", response_id: "resp-A", usage, thread_token_usage: usage }
          : { type: "token_count", ...(this.nativeCase ? {} : { call_id: "A", ...(copy === "laptop" && { request_id: "R" }) }),
            info: { last_token_usage: usage, ...(this.nativeCase && { total_token_usage: usage }) } };
        await f.append(copy, { timestamp, type: native ? "token_usage_record" : "event_msg", payload });
      }
      await f.scan(site);
      const view = await f.scan(site === "desktop" ? "laptop" : "desktop");
      assert.deepEqual(await f.scan(site), view);
      this.evidenceViews.push(view);
    } finally { await f.close(); }
  }
});

Then("each session shows one 10-token Codex call", function (this: EvidenceScenario) {
  for (const view of this.evidenceViews) {
    assert.equal(view.observedTotalTokens, 10);
    assert.equal(view.coverage, "reported");
    assert.equal(view.usage.length, 1);
    assert.equal(view.usage[0].requestId, "R");
  }
});

Then("each session shows one 120-token native response owned by its thread", function (this: EvidenceScenario) {
  for (const view of this.evidenceViews) {
    assert.equal(view.observedTotalTokens, 120);
    assert.equal(view.coverage, "reported");
    assert.equal(view.usage.length, 1);
    assert.partialDeepStrictEqual(view.usage[0], { responseId: "resp-A", turnId: "turn" });
  }
});
