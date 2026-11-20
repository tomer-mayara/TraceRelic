import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeChat } from "#src/scan/claude-chat";
import { ClaudeChatFixture as F } from "../../fixtures/claude-chat-fixture.ts";

test("filters complete generated goal and tick envelopes while preserving quoted examples", () => {
  const rows = [F.row("user", "<tick>resume</tick>"), F.row("user", [F.text("<goal>generated</goal>"), F.text("Continue")]),
    F.row("user", "What does <goal>example</goal> mean?"), F.row("user", "`<tick>resume</tick>`")];
  assert.deepEqual(ClaudeChat.decode(F.transcript(rows)).messages.map(row => row.text),
    ["Continue", "What does <goal>example</goal> mean?", "`<tick>resume</tick>`"]);
});

test("returns exact text, roles, recorded times and original block positions", () => {
  const { messages, metadata } = ClaudeChat.decode(F.transcript([
    F.row("user", " Why?\n"),
    F.row("assistant", [F.text("  One"), { type: "tool_use" }, { type: "thinking", text: "hidden" }, F.text("Two\n")]),
    F.row("user", [{ type: "image" }, { type: "tool_result", content: "hidden" }, F.text(" With context ")]),
    F.row("assistant", "Plain answer"),
    F.row("user", "Undated", { timestamp: undefined }),
    F.row("system", "System policy"),
    F.row("attachment", "Attached file"),
    F.row("user", "Mismatched role", { type: "assistant" }),
  ]));
  assert.deepEqual(messages.map(m => [m.role, m.text, m.at, m.sourceOrder, m.blockIndex]), [
    ["user", " Why?\n", F.at, 1, 0], ["assistant", "  One", F.at, 2, 0],
    ["assistant", "Two\n", F.at, 2, 3], ["user", " With context ", F.at, 3, 2],
    ["assistant", "Plain answer", F.at, 4, 0],
  ]);
  assert.deepEqual(metadata, {});
});

test("omits injected context while keeping quoted markers and genuine blocks in mixed messages", () => {
  const reminder = "<system-reminder>Internal</system-reminder>";
  const quote = "Explain " + reminder;
  const { messages } = ClaudeChat.decode(F.transcript([
    F.row("user", "Injected", { isMeta: true }),
    F.row("user", "Summary", { isCompactSummary: true }),
    F.row("user", [F.text("[Request interrupted by user]")]),
    F.row("user", "[Request interrupted by user for tool use]"),
    F.row("user", "Why does it say [Request interrupted by user]?"),
    F.row("user", "<local-command-stdout>secret</local-command-stdout>"),
    F.row("user", "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"),
    F.row("assistant", "", { message: { role: "assistant", model: "<synthetic>", content: "[Request interrupted]" } }),
    F.row("user", [F.text(reminder), F.text(quote)]),
    F.row("assistant", reminder),
  ]));
  assert.deepEqual(messages.map(m => [m.text, m.blockIndex]), [
    ["Why does it say [Request interrupted by user]?", 0], [quote, 1], [reminder, 0],
  ]);
});

test("identifies blocks by row UUID across copies despite shared request and API message IDs", () => {
  const fields = { requestId: "one-request" };
  const rows = [
    F.row("assistant", [F.text("a"), F.text("b")], { ...fields, uuid: "one" }),
    F.row("assistant", "c", { ...fields, uuid: "two" }),
    F.row("user", "Anonymous"),
  ];
  const original = ClaudeChat.decode(F.transcript(rows)).messages;
  const copy = ClaudeChat.decode(F.transcript([rows[2], ...rows], "/fixture/previous.jsonl", true)).messages;
  assert.equal(new Set(original.map(m => m.id)).size, 4);
  assert.deepEqual(copy.map(m => m.id), original.slice(0, 3).map(m => m.id));
});

test("fallback IDs retain repeated identical prompts and are stable and source scoped", () => {
  const prompt = F.row("user", "Again?");
  const ids = (rows: typeof prompt[], file?: string) => ClaudeChat.decode(F.transcript(rows, file)).messages.map(m => m.id);
  const repeated = ids([prompt, prompt]);
  assert.equal(new Set(repeated).size, 2);
  assert.deepEqual(ids([prompt, prompt, prompt]).slice(0, 2), repeated);
  assert.deepEqual(ids([F.row("system", "Earlier"), prompt, prompt]), repeated);
  assert.notEqual(ids([prompt], "/fixture/other.jsonl")[0], repeated[0]);
});

test("attaches only row context and records the source position of the last branch", () => {
  const { messages, metadata, branchObservation } = ClaudeChat.decode(F.transcript([
    F.row("user", "First", { cwd: "/work", gitBranch: "main", turnId: "turn-1", requestId: "request-1" }),
    F.row("user", "Again"),
    F.row("assistant", [{ type: "tool_use" }], { gitBranch: "next" }),
    F.row("assistant", "Last"),
  ]));
  assert.deepEqual(messages.map(m => [m.context, m.turnId, m.requestId]), [
    [{ cwd: "/work", branch: "main" }, "turn-1", "request-1"],
    [undefined, undefined, undefined], [undefined, undefined, undefined],
  ]);
  assert.deepEqual(metadata, { cwd: "/work", branch: "next" });
  assert.deepEqual(branchObservation, { at: F.at, sourceOrder: 3 });
});

test("keeps embedded IDE or hook examples and excludes standalone injected user blocks", () => {
  for (const tag of ["ide_opened_file", "ide_selection", "session-start-hook"]) {
    const envelope = `<${tag}>\ncontext\n</${tag}>`;
    const prompt = `Explain ${envelope} please.`;
    const { messages } = ClaudeChat.decode(F.transcript([
      F.row("user", [F.text(envelope), F.text(prompt)]),
      F.row("assistant", envelope),
    ]));
    assert.deepEqual(messages.map(m => [m.text, m.blockIndex]), [[prompt, 1], [envelope, 0]]);
  }
});

test("uses the recorded outer role when the inner role is absent", () => {
  const { messages } = ClaudeChat.decode(F.transcript([
    { type: "user", timestamp: F.at, message: { content: "Question" } },
    { type: "assistant", timestamp: F.at, message: { content: [F.text("Answer")] } },
    { type: "system", timestamp: F.at, message: { content: "Hidden" } },
  ]));
  assert.deepEqual(messages.map(m => [m.role, m.text]), [["user", "Question"], ["assistant", "Answer"]]);
});

test("attaches a recorded repository only to the row that supplied it", () => {
  const repository = "https://example.org/team/project.git";
  const { messages, metadata } = ClaudeChat.decode(F.transcript([
    F.row("user", "First", { repository }), F.row("user", "Later", { repository: "" }),
  ]));
  assert.deepEqual(messages.map(m => m.context), [{ repository }, undefined]);
  assert.deepEqual(metadata, { repository });
});

test("a fresh parser retains anonymous block IDs and emits only newly recorded text and metadata", () => {
  const blocks = [F.text("A private question"), { type: "tool_use" }, F.text("A second part")];
  const prompt = F.row("user", blocks);
  const transcript = F.transcript([
    F.row("assistant", [{ type: "tool_use" }], { gitBranch: "main", cwd: "/work" }), prompt, prompt,
    F.row("assistant", [{ type: "tool_use" }], { gitBranch: "next" }),
  ]);
  const { entries } = transcript;
  const first = ClaudeChat.resume(false);
  const accepted = first.decodeBatch(entries.slice(0, 2));
  assert.deepEqual(accepted.branchObservation, { sourceOrder: 1, at: F.at });
  const saved = JSON.stringify(first.snapshot());
  assert.ok(!saved.includes("A private question"));
  const fresh = ClaudeChat.resume(false, JSON.parse(saved));
  const suffix = fresh.decodeBatch(entries.slice(2, 3));
  assert.deepEqual(suffix.messages, ClaudeChat.decode(transcript).messages.slice(2));
  assert.deepEqual(suffix.metadata, {});
  assert.equal(suffix.branchObservation, undefined);
  assert.equal(new Set([...accepted.messages, ...suffix.messages].map(m => m.id)).size, 4);
  assert.deepEqual(fresh.decodeBatch(entries.slice(3)), {
    messages: [], metadata: { branch: "next" }, branchObservation: { sourceOrder: 4, at: F.at },
  });
});

test("a resumed earlier copy accepts only UUID-backed records and keeps their actual block positions", () => {
  const { entries } = F.transcript([
    F.row("user", "Accepted", { uuid: "one", gitBranch: "main" }),
    F.row("user", "Anonymous", { gitBranch: "unverified" }),
    F.row("assistant", [{ type: "tool_use" }, F.text("Additional")], { uuid: "two" }),
  ], "/fixture/previous.jsonl", true);
  const first = ClaudeChat.resume(true);
  first.decodeBatch(entries.slice(0, 1));
  const fresh = ClaudeChat.resume(true, JSON.parse(JSON.stringify(first.snapshot())));
  assert.deepEqual(fresh.decodeBatch(entries.slice(1)), {
    messages: [{ id: "native:two:1", role: "assistant", at: F.at, sourceOrder: 3, blockIndex: 1, text: "Additional" }],
    metadata: {},
  });
});

test("rejects malformed Claude checkpoint state without disclosing the supplied data", () => {
  const detail = "private record contents";
  for (const state of [null, [], detail, { occurrences: detail }, { occurrences: { ["a".repeat(64)]: -1 } }]) {
    assert.throws(() => ClaudeChat.resume(false, state), { name: "Error", message: "Invalid chat parser state" });
  }
});
