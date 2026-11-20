import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexChat } from "#src/scan/codex-chat";
import { CodexChatFixture as F } from "../../fixtures/codex-chat-fixture.ts";

test("paginated completed items honor the provider's recorded display decision", () => {
  const completed = (id: string, moderation: object) => F.record("event_msg", { type: "item_completed",
    item: { type: "AgentMessage", id, moderation, content: [{ type: "Text", text: id }] } });
  const rows = F.entries(F.record("session_meta", { id: "planning", history_mode: "paginated" }),
    F.response("assistant", [F.output("Hidden body")]), completed("Hidden body", { moderated: true,
      display: { version: 1, mode: "hide", replacement: { kind: "wellbeingPromptHelpline" } } }),
    completed("Blocked", { moderated: true, display: { version: 1, mode: "block", reason: { kind: "protection", protectionType: "fixture" } } }),
    completed("Restricted", { moderated: true }), completed("Unsupported display", { moderated: false, display: { version: 2, mode: "show" } }),
    completed("Shown", { moderated: true, display: { version: 1, mode: "show", trustedContacts: "skip" } }));
  assert.deepEqual(CodexChat.decode(rows).messages.map(row => row.text), ["Shown"]);
});

test("the joined legacy assistant mirror identifies every original block once in either order", () => {
  const typed = F.response("assistant", [F.output("First "), F.output("second")], { id: "answer" });
  const joined = F.event("agent_message", "First second", { moderation: { item_id: "answer", moderated: false } });
  for (const rows of [[typed, joined], [joined, typed]]) {
    assert.deepEqual(CodexChat.decode(F.entries(...rows)).messages.map(row => [row.id, row.text]), [
      ["native:answer:0", "First "], ["native:answer:1", "second"],
    ]);
  }
});

test("damage clears unverified turn attribution and prevents lookahead pairing across the gap", async () => {
  const rows = F.entries(F.record("turn_context", { turn_id: "old", request_id: "request" }),
    F.event("user_message", "Same"), F.record("other", {}), F.response("user", [F.input("Same")], { id: "new" }));
  const gap = [{ lineNumber: 3, startOffset: 100, endOffset: 110 }];
  const parser = CodexChat.resume();
  await parser.prepareLookahead(rows.slice(0, 2), (async function*() { yield { entries: rows.slice(3), damagedLines: gap }; })(), 0);
  const first = parser.decodeBatch(rows.slice(0, 2)).messages;
  const last = parser.decodeBatch(rows.slice(3), gap).messages;
  assert.equal(first[0].turnId, "old");
  assert.equal(first[0].id.startsWith("text:"), true);
  assert.deepEqual(last.map(row => [row.id, row.turnId, row.requestId]), [["native:new:0", undefined, undefined]]);
});

test("keeps source and block order, recorded time, and one copy of mirrored text", () => {
  const entries = F.entries(
    F.response("user", [F.input("Plan search")]),
    F.event("user_message", "Plan search"),
    F.response("assistant", [null, F.output(" Start with ranking\n"), { type: "image" }, F.output("Then measure it")]),
    F.event("agent_message", " Start with ranking\n"),
    F.event("agent_message", "Then measure it"),
    { ...F.event("user_message", "Continue"), timestamp: "2026-04-15T08:55:00-06:00" },
  );
  const { messages, metadata, branchObservation } = CodexChat.decode(entries);
  assert.deepEqual(messages.map(m => [m.role, m.text, m.at, m.sourceOrder, m.blockIndex]), [
    ["user", "Plan search", F.at, 1, 0],
    ["assistant", " Start with ranking\n", F.at, 3, 1],
    ["assistant", "Then measure it", F.at, 3, 3],
    ["user", "Continue", "2026-04-15T08:55:00-06:00", 6, 0],
  ]);
  assert.deepEqual(metadata, {});
  assert.equal(branchObservation, undefined);
  assert.ok(messages.every(m => m.context === undefined && m.turnId === undefined && m.requestId === undefined));
});

test("preserves identical prompts and consumes each opposite-format mirror only once", () => {
  const first = F.event("user_message", "Again?");
  const response = F.response("user", [F.input("Again?")]);
  const entries = F.entries(first, response, response, first, first);
  const prior = CodexChat.decode(entries.slice(0, 1)).messages;
  const { messages } = CodexChat.decode(entries);
  assert.deepEqual(messages.map(m => m.sourceOrder), [1, 3, 5]);
  assert.deepEqual(messages[0], prior[0]);
  assert.equal(new Set(messages.map(m => m.id)).size, 3);
  assert.deepEqual(CodexChat.decode(entries).messages, messages);
});

test("a later native mirror cannot renumber the other occurrences of an unidentified prompt", () => {
  const prompt = F.event("user_message", "Again?");
  const before = CodexChat.decode(F.entries(prompt, prompt)).messages;
  const after = CodexChat.decode(F.entries(
    prompt, prompt, F.response("user", [F.input("Again?")], { id: "native-first" }), prompt,
  )).messages;
  assert.equal(after[1].id, before[1].id);
  assert.ok(before.every(m => m.id !== after[2].id));
});

test("a typed user message and its flattened event keep the original text blocks in either order", () => {
  const event = F.event("user_message", "Plan search");
  const response = F.response("user", [
    F.input("Plan "), { type: "input_image", image_url: "fixture-image" }, F.input("search"),
  ]);
  for (const entries of [F.entries(response, event), F.entries(event, response)]) {
    assert.deepEqual(CodexChat.decode(entries).messages.map(m => [m.text, m.sourceOrder, m.blockIndex]), [
      ["Plan ", 1, 0], ["search", 1, 2],
    ]);
  }
});

test("the typed mirror supplies its native identity and context while keeping the first recorded position", () => {
  const event = F.event("agent_message", "Same reply");
  const typed = {
    ...F.response("assistant", [{ type: "refusal" }, F.output("Same reply")], {
      id: "msg-A", request_id: "r1", cwd: "/work/search",
      internal_chat_message_metadata_passthrough: { turn_id: "turn-A" },
    }),
    timestamp: F.later,
  };
  const [native] = CodexChat.decode(F.entries(typed)).messages;
  assert.deepEqual(CodexChat.decode(F.entries(event, typed)).messages, [
    { ...native, at: F.at, sourceOrder: 1 },
  ]);
  assert.deepEqual(CodexChat.decode(F.entries(typed, event)).messages, [native]);
});

test("a new turn, role change or distinct message ID keeps equal prompts independent", () => {
  const prompt = F.event("user_message", "Again?");
  const sameText = F.response("user", [F.input("Again?")]);
  const entries = F.entries(
    F.record("event_msg", { type: "task_started", turn_id: "a" }),
    prompt,
    F.record("event_msg", { type: "task_complete", turn_id: "a" }),
    F.record("turn_context", { turn_id: "b" }),
    sameText,
    F.event("agent_message", "First reply"),
    prompt,
    F.response("user", [F.input("Explicit")], { message_id: "m-1", turn_id: "b" }),
    F.event("user_message", "Explicit", { message_id: "m-2", turn_id: "b" }),
    F.response("user", [F.input("Another turn")], { turn_id: "c" }),
    F.event("user_message", "Another turn", { turn_id: "d" }),
  );
  assert.deepEqual(CodexChat.decode(entries).messages.map(m => [m.text, m.turnId]), [
    ["Again?", "a"], ["Again?", "b"], ["First reply", "b"], ["Again?", "b"],
    ["Explicit", "b"], ["Explicit", "b"], ["Another turn", "c"], ["Another turn", "d"],
  ]);
});

test("only user and assistant text enters the chat, including prompts that quote context markers", () => {
  const env = "<environment_context>\n  <cwd>/private</cwd>\n</environment_context>";
  const agents = "# AGENTS.md instructions for /fixture\n\n<INSTRUCTIONS>\nInternal instructions\n</INSTRUCTIONS>";
  const quoted = "Explain this example:\n" + env;
  const entries = F.entries(
    F.response("developer", [F.input("internal policy")]), F.response("system", [F.input("system policy")]),
    F.response("user", [F.input(agents), F.input(env)]),
    F.event("user_message", env),
    F.record("response_item", { type: "reasoning", summary: [F.output("hidden")] }),
    F.record("response_item", { type: "function_call_output", output: "shell output" }),
    F.record("event_msg", { type: "agent_reasoning", message: "hidden" }),
    F.response("assistant", [F.input("wrong type"), { type: "reasoning_text", text: "private" }]),
    F.response("user", [
      F.input('<image name=[Image #1] path="/private/file.png">'), { type: "input_image", image_url: "private" },
      F.input("</image>"), F.input(quoted), F.output("wrong type"),
    ]),
    F.event("user_message", quoted, { images: ["private"] }),
    F.event("user_message", "", { images: ["private"] }),
    F.response("assistant", [F.output(env)]),
    { ...F.event("agent_message", "Undated answer"), timestamp: undefined },
  );
  assert.deepEqual(CodexChat.decode(entries).messages.map(m => [m.role, m.text, m.blockIndex]), [
    ["user", quoted, 3], ["assistant", env, 0],
  ]);
});

test("records native IDs independently of text or file position, plus the real block index", () => {
  for (const recordId of [false, true]) {
    const make = (first: string, last: string) => {
      const item = F.response("assistant", [F.output(first), F.output(last)], recordId ? {} : { id: "msg-01" });
      return recordId ? { ...item, id: "row-01" } : item;
    };
    const original = CodexChat.decode(F.entries(make("one", "two"))).messages;
    const replay = CodexChat.decode(F.entries(F.record("session_meta", { id: "planning" }), make("changed", "new"))).messages;
    assert.deepEqual(original.map(m => m.id), replay.map(m => m.id));
    assert.notEqual(original[0].id, original[1].id);
  }
});

test("uses native user text attribution and omits harness instructions and shell output", () => {
  const example = "<environment_context>example</environment_context>";
  const entries = F.entries(
    F.response("user", [
      F.input("Harness instructions"), F.input("Environment description"), F.input(example), F.input("shell output"),
      F.input("Legacy prompt"),
    ], { internal_chat_message_metadata_passthrough: {
      content_item_kinds: ["agents_md.instructions", "environments.environment_context", "user.text", "shell.user_command", "unknown"],
    } }),
    F.response("user", [
      F.input("<skill>private skill instructions</skill>"),
      F.input('<codex_internal_context source="extension">internal steering</codex_internal_context>'),
      F.input("<user_shell_command><command>pwd</command><result>private cwd</result></user_shell_command>"),
    ]),
    F.event("user_message", "Please explain the tag <skill>."),
    F.response("assistant", [F.output("private analysis")], { channel: "analysis" }),
  );
  assert.deepEqual(CodexChat.decode(entries).messages.map(m => [m.text, m.blockIndex]), [
    [example, 2], ["Legacy prompt", 4], ["Please explain the tag <skill>.", 0],
  ]);
});

test("captures recorded message context and the actual line and time of the last branch observation", () => {
  const repository = "https://example.org/search.git";
  const entries = F.entries(
    { type: "session_meta", payload: { id: "planning", cwd: "/work/search", git: { repository_url: repository } } },
    { type: "turn_context", payload: { turn_id: "a", request_id: "r-1" } },
    F.event("user_message", "First"),
    F.record("turn_context", { turn_id: "b", cwd: "/work/search/tools", git: { branch: "main" } }),
    F.event("agent_message", "On main", { request_id: "r-2" }),
    F.record("turn_context", { turn_id: "c", cwd: "/work/search/tools", git: { branch: "next" } }, F.later),
    F.response("user", [F.input("On next")]),
    F.record("event_msg", { type: "token_count" }, "2026-04-16T00:00:00Z"),
  );
  const { messages, metadata, branchObservation } = CodexChat.decode(entries);
  assert.deepEqual(messages.map(m => [m.turnId, m.requestId, m.context]), [
    ["a", "r-1", { cwd: "/work/search", repository }],
    ["b", "r-2", { cwd: "/work/search/tools", branch: "main", repository }],
    ["c", undefined, { cwd: "/work/search/tools", branch: "next", repository }],
  ]);
  assert.deepEqual(metadata, { cwd: "/work/search/tools", branch: "next", repository });
  assert.deepEqual(branchObservation, { at: F.later, sourceOrder: 6 });
});

test("a branch hint from a previous repository does not identify a message in another repository", () => {
  const entries = F.entries(
    F.record("session_meta", { id: "planning", cwd: "/work/one", git: { repository_url: "repo-one", branch: "main" } }),
    F.record("turn_context", { turn_id: "b", cwd: "/work/two", git: { repository_url: "repo-two" } }),
    F.event("user_message", "Continue here"),
  );
  const { messages, metadata, branchObservation } = CodexChat.decode(entries);
  assert.deepEqual(messages[0].context, { cwd: "/work/two", repository: "repo-two" });
  assert.equal(metadata.branch, "main");
  assert.deepEqual(branchObservation, { at: F.at, sourceOrder: 1 });
});

test("a fresh parser restores turn context and anonymous occurrences but emits only this batch's observations", () => {
  const prompt = F.event("user_message", "A repeated private prompt");
  const entries = F.entries(
    F.record("session_meta", { id: "planning", cwd: "/work", git: { repository_url: "repo", branch: "main" } }),
    F.record("turn_context", { turn_id: "turn", request_id: "request" }),
    prompt, prompt,
    F.record("turn_context", { turn_id: "turn", git: { branch: "next" } }, F.later),
  );
  const first = CodexChat.resume();
  const accepted = first.decodeBatch(entries.slice(0, 3));
  assert.deepEqual(accepted.branchObservation, { sourceOrder: 1, at: F.at });
  const saved = JSON.stringify(first.snapshot());
  assert.ok(!saved.includes("A repeated private prompt"));
  const fresh = CodexChat.resume(JSON.parse(saved));
  const suffix = fresh.decodeBatch(entries.slice(3, 4));
  assert.deepEqual(suffix.messages, CodexChat.decode(entries).messages.slice(1));
  assert.notEqual(suffix.messages[0].id, accepted.messages[0].id);
  assert.deepEqual(suffix.messages[0].context, { cwd: "/work", repository: "repo", branch: "main" });
  assert.equal(suffix.messages[0].turnId, "turn");
  assert.equal(suffix.messages[0].requestId, "request");
  assert.deepEqual(suffix.metadata, {});
  assert.equal(suffix.branchObservation, undefined);
  assert.deepEqual(fresh.decodeBatch(entries.slice(4)), {
    messages: [], metadata: { branch: "next" }, branchObservation: { sourceOrder: 5, at: F.later },
  });
});

test("opposite-format rows across a checkpoint consume one pending copy and preserve accepted blocks", () => {
  const event = F.event("user_message", "private prompt");
  const typed = F.response("user", [F.input("private "), { type: "input_image" }, F.input("prompt")], { id: "item" });
  for (const [original, mirror] of [[event, typed], [typed, event]]) {
    const entries = F.entries(original, mirror, mirror);
    const first = CodexChat.resume();
    const accepted = first.decodeBatch(entries.slice(0, 1));
    assert.deepEqual(accepted.messages, CodexChat.decode(entries.slice(0, 1)).messages);
    const saved = JSON.stringify(first.snapshot());
    assert.ok(!saved.includes("private "));
    const fresh = CodexChat.resume(JSON.parse(saved));
    assert.deepEqual(fresh.decodeBatch(entries.slice(1, 2)).messages, []);
    const later = fresh.decodeBatch(entries.slice(2)).messages;
    assert.deepEqual(later.map(m => [m.text, m.sourceOrder, m.blockIndex]),
      CodexChat.decode(entries.slice(2)).messages.map(m => [m.text, m.sourceOrder, m.blockIndex]));
  }
});

test("restored mirror evidence respects request IDs and role and turn boundaries", () => {
  const event = F.event("user_message", "Again?", { request_id: "r1", turn_id: "t1" });
  const typed = F.response("user", [F.input("Again?")], { request_id: "r1", turn_id: "t1" });
  const entries = F.entries(
    event,
    F.response("user", [F.input("Again?")], { request_id: "r2", turn_id: "t1" }),
    typed,
    event, F.event("agent_message", "Answer"), typed,
    F.record("event_msg", { type: "task_complete" }), event,
  );
  const expected = CodexChat.decode(entries).messages;
  let parser = CodexChat.resume();
  const messages = entries.flatMap(entry => {
    parser = CodexChat.resume(JSON.parse(JSON.stringify(parser.snapshot())));
    return parser.decodeBatch([entry]).messages;
  });
  assert.deepEqual(messages, expected);
  assert.deepEqual(messages.map(m => m.sourceOrder), [1, 2, 4, 5, 6, 8]);
});

test("rejects malformed Codex checkpoint state without disclosing the supplied data", () => {
  const detail = "private record contents";
  const saved = CodexChat.resume().snapshot();
  for (const state of [null, [], detail, { ...saved, context: { cwd: 42 } }, { ...saved, mirrors: { [detail]: [] } }]) {
    assert.throws(() => CodexChat.resume(state), { name: "Error", message: "Invalid chat parser state" });
  }
});

test("a pending mirror distinguishes a JSON surrogate escape from the replacement character", () => {
  const entries = F.entries(F.event("user_message", "\uD800"), F.response("user", [F.input("\uFFFD")]));
  const first = CodexChat.resume();
  first.decodeBatch(entries.slice(0, 1));
  const fresh = CodexChat.resume(JSON.parse(JSON.stringify(first.snapshot())));
  assert.deepEqual(fresh.decodeBatch(entries.slice(1)).messages.map(message => message.text), ["\uFFFD"]);
});

test("a typed copy later in the captured file supplies its blocks, identity and context across batch boundaries", async () => {
  const entries = F.entries(
    F.event("user_message", "Café 🦊", { cwd: "/first" }),
    F.record("event_msg", { type: "token_count" }),
    F.record("event_msg", { type: "token_count" }),
    { ...F.response("user", [F.input("Café "), { type: "input_image" }, F.input("🦊")], {
      id: "typed", turn_id: "t", request_id: "r", cwd: "/later", repository: "repo",
    }), timestamp: F.later },
  );
  const first = entries.slice(0, 1);
  for (const tail of [[entries.slice(1)], [entries.slice(1, 2), entries.slice(2, 3), entries.slice(3)]]) {
    const parser = CodexChat.resume();
    const initial = parser.snapshot();
    await parser.prepareLookahead(first, F.batches(...tail), 0);
    assert.deepEqual(parser.snapshot(), initial);
    const visible = parser.decodeBatch(first);
    assert.deepEqual(visible.messages, CodexChat.decode(entries).messages);
    assert.deepEqual(visible.messages.map(m => [m.id, m.text, m.sourceOrder, m.at, m.context]), [
      ["native:typed:0", "Café ", 1, F.at, { cwd: "/first", repository: "repo" }],
      ["native:typed:2", "🦊", 1, F.at, { cwd: "/first", repository: "repo" }],
    ]);
    assert.deepEqual(visible.metadata, { cwd: "/first" });
    assert.deepEqual(tail.flatMap(batch => parser.decodeBatch(batch).messages), []);
  }
});

test("an event later in the captured file can identify a typed assistant block in an earlier batch", async () => {
  const entries = F.entries(
    { ...F.response("assistant", [F.output("One"), { type: "refusal" }, F.output("Two")]), id: "row" },
    F.event("agent_message", "Two", { message_id: "second", request_id: "r2" }),
    F.event("agent_message", "One", { message_id: "first" }),
  );
  const parser = CodexChat.resume();
  await parser.prepareLookahead(entries.slice(0, 1), F.batches(entries.slice(1, 2), entries.slice(2)), 0);
  const visible = parser.decodeBatch(entries.slice(0, 1));
  assert.deepEqual(visible.messages, CodexChat.decode(entries).messages);
  assert.deepEqual(visible.messages.map(m => [m.id, m.requestId, m.blockIndex]), [
    ["native:first:0", undefined, 0], ["native:second:2", "r2", 2],
  ]);
  assert.deepEqual(parser.decodeBatch(entries.slice(1)).messages, []);
});

test("lookahead consumes mirrors for accepted rows before assigning later copies to new identical prompts", async () => {
  const flat = F.event("user_message", "Again?");
  const typed = (id: string) => F.response("user", [F.input("Again"), F.input("?")], { id });
  const entries = F.entries(flat, flat, typed("old"), typed("new"));
  const prior = CodexChat.resume();
  const accepted = prior.decodeBatch(entries.slice(0, 1));
  const parser = CodexChat.resume(JSON.parse(JSON.stringify(prior.snapshot())));
  const first = entries.slice(1, 2);
  const tail = [entries.slice(2, 3), entries.slice(3)];
  await parser.prepareLookahead(first, F.batches(...tail), 1);
  assert.deepEqual(parser.decodeBatch(first).messages.map(m => [m.id, m.text, m.sourceOrder]), [
    ["native:new:0", "Again", 2], ["native:new:1", "?", 2],
  ]);
  assert.deepEqual(tail.flatMap(batch => parser.decodeBatch(batch).messages), []);
  assert.deepEqual(accepted.messages.map(m => m.text), ["Again?"]);
});
