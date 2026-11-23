import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalLLMHistory } from "@tracerelic/collector/history";
import { MockHistoryProvider } from "../../fixtures/mock-history-provider.ts";

const start = new Date("2026-02-01T00:00:00Z");
const end = new Date("2026-02-02T00:00:00Z");
const rangeError = (message: string) => (error: unknown) => error instanceof RangeError && error.message === message;

test("reads the providers together and returns their entries in the order of the providers", async () => {
  let release!: () => void;
  const later = new Promise<void>(resolve => { release = resolve; });
  const codexEntries = [MockHistoryProvider.entry("codex", "c1", "2026-02-01T09:00:00Z"), MockHistoryProvider.entry("codex", "c2", "2026-02-01T10:00:00Z")];
  const claudeEntries = [MockHistoryProvider.entry("claude", "h1", "2026-02-01T08:00:00Z")];
  const codex = new MockHistoryProvider("codex", codexEntries, later);
  const claude = new MockHistoryProvider("claude", claudeEntries);

  const reading = new LocalLLMHistory([codex, claude]).readLocalHistory(start, end);
  assert.equal(claude.windows.length, 1, "the second provider starts before the first provider finishes");
  release();
  assert.deepEqual(await reading, [...codexEntries, ...claudeEntries]);

  const reversed = new LocalLLMHistory([claude, codex]);
  assert.deepEqual(await reversed.readLocalHistoryInstants("2026-02-01T00:00:00Z", "2026-02-02T00:00:00Z"), [...claudeEntries, ...codexEntries]);
});

test("gives each provider the same window with an inclusive start and an exclusive end", async () => {
  const providers = [new MockHistoryProvider("codex"), new MockHistoryProvider("claude")];
  const reader = new LocalLLMHistory(providers);

  await reader.readLocalHistory(start, end);
  const [days] = providers[0].windows;
  assert.equal(providers[1].windows[0], days);
  for (const inside of ["2026-02-01T00:00:00Z", "2026-01-31T19:00:00-05:00", "2026-02-01T23:59:59.999999Z"]) {
    assert.equal(days.contains(inside), true, inside);
  }
  for (const outside of ["2026-01-31T23:59:59.999Z", "2026-02-02T00:00:00Z", "2026-02-01T19:00:00-05:00"]) {
    assert.equal(days.contains(outside), false, outside);
  }

  await reader.readLocalHistoryInstants("2026-02-01T00:00:00.0001Z", "2026-02-01T00:00:00.0002Z");
  const instants = providers[0].windows[1];
  assert.equal(providers[1].windows[1], instants);
  for (const inside of ["2026-02-01T00:00:00.0001Z", "2026-02-01T00:00:00.00019Z"]) assert.equal(instants.contains(inside), true, inside);
  for (const outside of ["2026-02-01T00:00:00Z", "2026-02-01T00:00:00.0002Z"]) assert.equal(instants.contains(outside), false, outside);
});

test("rejects an invalid or reversed window before it calls a provider", async () => {
  const provider = new MockHistoryProvider("codex");
  const reader = new LocalLLMHistory([provider]);
  const dates = rangeError("Expected valid dates with fromDate at or before toDate");
  await assert.rejects(reader.readLocalHistory(new Date(NaN), end), dates);
  await assert.rejects(reader.readLocalHistory(start, new Date(NaN)), dates);
  await assert.rejects(reader.readLocalHistory(end, start), dates);
  const instants = rangeError("Expected valid instants with from at or before to");
  await assert.rejects(reader.readLocalHistoryInstants("2026-02-01", "2026-02-02T00:00:00Z"), instants);
  await assert.rejects(reader.readLocalHistoryInstants("2026-02-01T00:00:00Z", "2026-02-02T00:00:00"), instants);
  await assert.rejects(reader.readLocalHistoryInstants("2026-02-02T00:00:00Z", "2026-02-01T00:00:00Z"), instants);
  assert.deepEqual(provider.windows, []);
});

test("rejects with the error of a provider", async () => {
  const failure = Object.assign(new Error("EACCES: permission denied, scandir '/claude/projects'"), { code: "EACCES" });
  const reader = new LocalLLMHistory([new MockHistoryProvider("codex"), new MockHistoryProvider("claude", failure)]);
  await assert.rejects(reader.readLocalHistory(start, end), error => error === failure);
  await assert.rejects(reader.readLocalHistoryInstants("2026-02-01T00:00:00Z", "2026-02-02T00:00:00Z"), error => error === failure);
});

test("returns an empty list when no provider is supplied", async () => {
  const reader = new LocalLLMHistory([]);
  assert.deepEqual(await reader.readLocalHistory(start, end), []);
  assert.deepEqual(await reader.readLocalHistoryInstants("2026-02-01T00:00:00Z", "2026-02-02T00:00:00Z"), []);
  await assert.rejects(reader.readLocalHistory(end, start), RangeError);
});
