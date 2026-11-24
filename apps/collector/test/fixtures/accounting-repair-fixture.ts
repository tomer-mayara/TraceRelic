import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Batch, CollectorStorage, Harness } from "@tracerelic/collector/storage";
import { ClaudeUsageScanFixture } from "./claude-usage-scan-fixture.ts";
import { CodexUsageScanFixture } from "./codex-usage-scan-fixture.ts";
import { InMemoryCollectorStorage } from "./in-memory-collector-storage.ts";

class ReceivedBatch extends InMemoryCollectorStorage {
  received?: Batch;
  override commit(batch: Batch) {
    this.received = structuredClone(batch);
    return super.commit(batch);
  }
}

/** Recreate the recorded old envelopes against real, reproducible transcript prefixes. */
export async function accountingRepairFixture(example: Harness | "native-codex") {
  const harness = example === "native-codex" ? "codex" : example;
  const probe = new ReceivedBatch();
  const codex = await CodexUsageScanFixture.create();
  const claude = await ClaudeUsageScanFixture.create();
  const fixture = harness === "codex" ? codex : claude;
  if (example === "native-codex") {
    const amount = { input_tokens: 95, output_tokens: 25 };
    await codex.append("desktop", { type: "token_usage_record", timestamp: "2026-02-01T12:00:01Z",
      payload: { thread_id: codex.key.sessionId, turn_id: "turn", response_id: "response", usage: amount, thread_token_usage: amount } });
  } else if (harness === "codex") {
    const amount = { input_tokens: 8, output_tokens: 2 };
    for (const [i, ids] of [{ call_id: "A" }, { call_id: "A", request_id: "R" }, {}].entries()) {
      await codex.append("desktop", { timestamp: `2026-02-01T12:00:0${i}Z`, type: "event_msg", payload: {
        type: "token_count", ...ids, info: { last_token_usage: amount, ...(i === 2 && { total_token_usage: amount }) },
      } });
    }
  } else {
    const report = (second: number, id?: string) => claude.report(second, { input_tokens: 8, output_tokens: 2,
      iterations: [{ type: "advisor_message", id, input_tokens: 4, output_tokens: 2 }] }, { uuid: "row-" + second, final: second > 1 });
    await claude.append("desktop", report(1), report(2, "advisor-a"));
  }
  await fixture.scan("desktop", probe);
  const legacy = probe.received;
  assert(legacy);
  delete legacy.checkpoint.evidenceVersion;
  if (example === "native-codex") {
    const parser = JSON.parse(legacy.checkpoint.parserState);
    parser.decoder.usage = { historyId: parser.decoder.usage.historyId, disputed: [], observations: [], seen: {}, pending: [] };
    legacy.checkpoint.parserState = JSON.stringify(parser);
    legacy.usage = [];
    legacy.usageWindows = [];
    delete legacy.codexCallAliases;
    delete legacy.codexCallClaims;
  } else if (harness === "codex") {
    const [first, enriched] = legacy.usage;
    const alias = legacy.codexCallAliases?.[0].aliasUsageId;
    assert(alias && enriched && legacy.usageAnchors?.[0] && legacy.codexCallClaims?.[0]);
    const parser = JSON.parse(legacy.checkpoint.parserState);
    const usage = parser.decoder.usage;
    delete usage.aliases;
    delete usage.previousChange;
    usage.seen[alias] = usage.seen[first.id];
    legacy.checkpoint.parserState = JSON.stringify(parser);
    legacy.usage = [first, { ...enriched, id: alias }];
    legacy.usageWindows = [];
    legacy.usageAnchors.push({ ...legacy.usageAnchors[0], usageId: alias });
    legacy.codexCallClaims.push({ ...legacy.codexCallClaims[0], usageId: alias,
      providerId: createHash("sha256").update(JSON.stringify(["request", "R"])).digest("hex") });
    delete legacy.codexCallAliases;
    legacy.hasGap = true;
  } else {
    for (const row of legacy.claudeUsageReports ?? []) delete row.iterationPosition;
  }
  return { legacy, scan: (store: CollectorStorage) => fixture.scan("desktop", store),
    close: () => Promise.all([codex.close(), claude.close()]) };
}
