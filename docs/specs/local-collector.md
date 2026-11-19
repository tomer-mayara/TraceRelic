# TraceRelic local transcript collector

**Engineering handoff · Phase 1**

A developer can ask “What did this chat use?” and see its captured conversation and measured token total, even when the chat never edited a file. Collect locally persisted Codex and Claude Code sessions from the developer's machine. Keep request-level usage so a later feature can attribute part of a session to a PR.

**Storage decision.** The TraceRelic API owns durable storage remotely. Supabase Postgres is a candidate. The collector talks to a TraceRelic-owned interface. For development, inject the in-memory storage fixture supplied with this spec. The fixture models an acknowledged remote write and runs with synthetic data, without credentials, Docker, or network access. The collector, HTTP transport, and production database adapter described below are engineering work to follow.

## First end-to-end scenario to implement

```gherkin
Scenario: Reopening two planning chats preserves their measured usage
  Given a Codex chat with cumulative token totals of 120, 120, and 200
  And a Claude Code chat with one request using 40 input tokens
  And that request reports 2 output tokens and later 91
  When the collector scans twice and restarts against the same storage
  Then the Codex session shows 200 tokens and the Claude session shows 131
  And each original chat message appears once
```

## Components and data flow

| Owner | Responsibility |
| --- | --- |
| Local collector | Discover files, read completed JSONL records, interpret them with the matching adapter, and submit normalized batches. Start with a single `scan --once` entry point. Startup scans and periodic scans can call the same operation. |
| Codex and Claude adapters | Extract session identity, optional repository context, original message blocks and measured usage. Each adapter owns its file conventions, accounting rules and serialized parser state. |
| TraceRelic API | Authenticate the collector, bind it to one workspace, validate each batch and apply it atomically. Serve the acknowledged checkpoint and the session view. The collector receives a scoped TraceRelic credential. Database credentials belong on the server. |
| Storage fixture | Supply the same asynchronous port for one isolated workspace per instance. Keep the instance alive to simulate restarting the collector against the same remote store. A new instance starts empty. |

Implement the scanner under `apps/collector/src`. Put scheduling in `collector.ts`, byte reading in `transcripts/jsonl-reader.ts`, and provider rules in `providers/codex.ts` and `providers/claude-code.ts`. The included `storage/collector-storage.ts` defines the port that `testing/in-memory-collector-storage.ts` implements for tests. Put the future remote client in the collector and the ingestion handler and database adapter in `apps/api`. Generate shared wire models from the TypeSpec contract when both applications consume it.

The only durable inputs on the workstation for this phase are the transcripts the harnesses already write. The accepted read position and parser state live with the remote records. When the service is unavailable, leave the position at its last acknowledgement and catch up from the files on reconnect. This covers outages while the source files are retained. If a previously observed source disappears first, report a coverage gap with its last known position. Coverage starts with files the collector observes. An ephemeral chat or a file removed before discovery leaves no local transcript to recover.

## Discover and read

1. Accept configurable roots. Codex defaults to `~/.codex`, with `CODEX_HOME` as the override. Recursively find `rollout-*.jsonl` in `sessions/` and `archived_sessions/`. Claude Code defaults to `~/.claude/projects/` and resolves `projects/` relative to `CLAUDE_CONFIG_DIR` when set. Include nested subagent transcripts.
2. Use the harness and its native session ID as the session key, scoped by the authenticated workspace. Read the Codex ID from `session_meta.payload` (`id` or `session_id`) and the Claude ID from `sessionId`. If a Claude subagent repeats the parent's session ID, derive a child session key from the parent ID and the native agent ID, using a reserved, unambiguous encoding. Capture observed working directory, repository, branch and parent identifiers when present. Missing metadata is valid. The latest observed branch is a session hint. Later PR attribution needs the branch observed at the time of the turn.
3. Identify a logical stream by its native identity and an ordered generation, independently of its path. Moving a rollout into the archive preserves the stream identity. Look up generation zero, verify the saved content anchor, and seek to the acknowledged byte offset. On truncation, a replaced prefix, or an unsupported parser-state version, try successive generation keys until a checkpoint matches or a new generation starts at zero. Reconciliation uses stable record IDs. This lookup also works after a process restart. Save the adapter version, provider state and a prefix digest in the checkpoint. Use a boundary sample on routine appends and verify the committed prefix on suspected rewrites.
4. Process bounded batches of complete newline-terminated UTF-8 records in file order. Leave an unfinished last line for the next scan. Ignore recognized bookkeeping records. For a malformed completed line or an unsupported usage shape, record a diagnostic with the stream and offset, mark any affected usage incomplete, and continue with the next line. Log counts and identifiers. Keep conversation text in the transcript record.
5. Send the batch and resulting checkpoint in one commit. After a timeout or disconnection, back off, re-read the checkpoint and resume there. This also handles a lost acknowledgement after a successful write. On `invalid`, report the source and byte range and pause that stream for diagnosis while other streams progress. A filesystem watcher, if added, only triggers the same scan.

## Convert transcripts into records

**Messages.** Keep the original user and assistant text blocks with an ID, timestamp and role, including planning and discussion. Codex `response_item` messages and Claude `message.content` are starting points. Pick one representation if a harness mirrors a message in multiple event types. Preserve separate blocks even if they share a model request. The phase-one message shape covers conversation text. Tool output, hidden reasoning, system instructions and binary attachments are outside it. A later PR detector that needs evidence such as a tool invocation of `gh pr create` will also need a tool-event record or Git-host event.

**Codex.** Read the current model from `turn_context` when available. Read usage from `event_msg` with payload type `token_count`. Keep the prior `info.total_token_usage` snapshot in the parser state. Ignore an identical cumulative snapshot. When it advances, take `info.last_token_usage` if present, otherwise subtract the previous counters. At a verified fresh session start the baseline is zero. If only per-call counts exist, use a stable source identity for the observation. A recognized rate-limit update with empty `info` adds no usage. An unexplained counter decrease or an unresolved inherited baseline creates a gap. Resume measuring at a known boundary.

For example, cumulative totals of 15,569, 33,105 and 33,105 contribute 15,569, 17,536 and 0. Codex `input_tokens` includes cached input. Its `output_tokens` includes reasoning output. [Codex local configuration](https://learn.chatgpt.com/docs/config-file/config-advanced) · [Git AI Codex accounting implementation](https://github.com/git-ai-project/git-ai/blob/5420ab9081d2cd57ffdafced09a8028d6dabf4bd/src/token_usage/codex.rs#L500-L555)

**Claude Code.** Read assistant `message.usage`. Identify a request using `message.id` and `requestId` when present. Its text may span multiple transcript records, and its usage may be corrected later. Keep the most complete authoritative observation. Calculate normalized input by adding `input_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`. For example, 10 ordinary input tokens, 25 cache reads and 5 cache writes yield 40 input tokens. If output snapshots for that request show 2 followed by 91, its final contribution is **131 tokens**. Detailed cache-write durations partition the cache-creation count. [Claude session format](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser) · [Claude token field definitions](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) · [Transcript fixture with repeated request IDs](https://github.com/git-ai-project/git-ai/blob/5420ab9081d2cd57ffdafced09a8028d6dabf4bd/tests/fixtures/example-claude-code.jsonl)

**Ownership and replay.** Count a model call in its originating session. Record the parent link for forks and subagents. A resumed or forked transcript can copy earlier calls. Use the original Claude message/request identities, including matched parent message IDs for known subagent replays. For Codex match inherited usage against the parent prefix before counting new calls. Give a child stream a distinct identity even if its file repeats the parent session ID. When ownership is ambiguous, preserve the text, flag a gap and omit the uncertain charge. Direct session totals sum only owned usage. A future parent rollup can include distinct child calls.

**Stable identities.** Prefer a native message or block ID and provider call ID. Otherwise derive a deterministic ID from the canonical stream and logical source record (the native ordinal when available, or a fingerprint plus its occurrence within the canonical stream). Two identical prompts at different positions are two messages. Keep IDs across archive moves, retries and rescans. A usage correction keeps its ID. Assign a positive revision ordered by the authoritative observations of that call, reproducible on replay. An earlier partial observation keeps its original revision.

## Remote storage contract and fixture

Each storage instance or authenticated request is bound to one workspace. The session key is `(harness, sessionId)`, with harness values `codex` and `claude`. The cursor key adds `streamId`, which identifies the stream generation. Identifiers are nonempty strings. Message and usage timestamps use RFC 3339. Record IDs are unique per session and record kind. The adapter resolves cross-session ownership before storage.

| Operation | Result |
| --- | --- |
| `readCheckpoint(source)` | The next unread byte offset and opaque, versioned parser-state string, or `null` before the first acknowledged write. The initial expected offset is 0. |
| `commit(batch)` | `committed`, `conflict` or `invalid`. A successful write stores the session, messages, usage and new checkpoint together. A transport failure may leave the caller uncertain whether the commit succeeded. |
| `readSession(key)` | Returns `null` before the session exists. Otherwise returns a detached view with metadata, messages, latest usage per ID, coverage and observed total. Callers order records by timestamp and ID when displaying a timeline. |

The batch has `source`, `expectedOffset`, `checkpoint`, `messages` and `usage`. Messages carry `id`, `at`, `role` (user or assistant) and `text`. Each usage observation carries `id`, `revision`, `at`, input and output counts, and an optional model and breakdown. Optional metadata fields `cwd`, `repository`, `branch` and `parentSessionId` patch the last observed values. A batch may carry only session metadata and its checkpoint, with empty message and usage arrays. Optional `hasGap: true` marks an unresolved usage gap for the session. A completed repair or full rebuild can re-establish coverage in a later phase.

The future HTTP boundary decodes incoming JSON against the wire schema. The fixture accepts typed batches and checks identifiers, timestamps, counts and update rules. Its read methods return independent copies, so mutating a test input or result cannot change an earlier commit.

- **Atomicity and retries.** Compare `expectedOffset` with the stored offset before writing. On `conflict` from a stale or repeated batch, reload the authoritative checkpoint. Only one simultaneous writer at that offset can commit. A valid next offset strictly advances. Invalid content rejects the entire batch, including its checkpoint.
- **Record updates.** Replaying identical content under the same message ID is idempotent. Different content under that ID is invalid. A higher usage revision replaces the full observation. An older revision is ignored. An equal revision is idempotent for identical data and invalid for different data.
- **Counts.** Input and output are inclusive nonnegative safe integers. Cache-read and cache-write counts are optional, disjoint subsets of input. Reasoning tokens are an optional subset of output. The observed total sums input plus output over the latest owned observations. A recorded zero is a measured zero. Zero observations produce `null` and `unknown`. When observations exist, use `partial` if a gap was recorded and `reported` otherwise. A partial total is the sum of the known observations.

For the future PostgreSQL adapter, include the authenticated workspace in the unique keys for sessions, stream checkpoints, messages and usage. Use one database transaction for the checkpoint comparison and all record updates, including the first write to a stream. Return `committed` only after the transaction succeeds. The fixture's same-offset race test is an acceptance test for that adapter as well.

### Synthetic batch example

```json
{
  "source": { "harness": "claude", "sessionId": "chat-1", "streamId": "main-v1" },
  "expectedOffset": 0,
  "checkpoint": { "offset": 420, "parserState": "{\"version\":1}" },
  "messages": [
    { "id": "m1", "role": "user", "at": "2026-01-01T00:00:00Z", "text": "Plan the search feature" }
  ],
  "usage": [
    { "id": "req1/msg1", "revision": 1, "at": "2026-01-01T00:00:01Z",
      "inputTokens": 40, "outputTokens": 2, "cacheReadTokens": 25, "cacheWriteTokens": 5 }
  ]
}
```

This batch returns `committed` and an observed total of 42. Retrying it returns `conflict` and the checkpoint remains 420. A subsequent batch starting at 420 can submit revision 2 with 91 output tokens. The resulting total is 131. Both transcript adapters submit normalized data through this port.

In a TypeScript test beside the fixture, pass the example above to `checkFirstUpload` as a `Batch`.

```ts
import assert from "node:assert/strict";
import type { Batch, CollectorStorage } from "../storage/collector-storage.js";
import { InMemoryCollectorStorage } from "./in-memory-collector-storage.js";

async function checkFirstUpload(batch: Batch) {
  const remote: CollectorStorage = new InMemoryCollectorStorage();
  assert.equal(await remote.commit(batch), "committed");
  assert.equal(await remote.commit(batch), "conflict");
  assert.equal((await remote.readSession(batch.source))?.observedTotalTokens, 42);
}
```

## Delivery and verification

| Component | Behavior | Observability | Architecture | Interface |
| --- | --- | --- | --- | --- |
| Collector and adapters (planned) | A planning session appears once after two scans, a restart and an archive move. A new turn adds only its measured usage. | Count discovered sessions, rejected or unsupported lines, incomplete usage, cursor conflicts and oldest pending source age. | The coordinator depends on file-reading, provider and storage interfaces. Each adapter owns its native format. | Native JSONL is external. Verify both adapters against synthetic provider fixtures with known messages and counts. |
| Storage port and fixture (included) | Verify a chat with unknown usage, a lost acknowledgement, a corrected request, and an atomic rejection. | Tests inspect outcomes, stored records and checkpoints. This in-process fixture introduces no production service objective. | Test code injects the fixture through the collector’s storage port. The API owns the future database adapter. | The TypeSpec operations below define the input, output and logical errors. The fixture implements them asynchronously. |
| Remote service (planned) | Run the same storage contract cases against the API in an isolated workspace, including competing writers and workspace separation. | Measure commit success, latency, retry age and rejected batches before setting a production SLO. | Only the service owns database connections. An adapter may use Supabase Postgres or another transactional store. | Bind workspace from the credential. Specify HTTP authentication, transport errors and versioning in TypeSpec when the remote transport is introduced. [Supabase database](https://supabase.com/docs/guides/database/overview) |

**Collector acceptance tests.** Run the opening scenario with a temporary transcript directory and the supplied fixture. Extend it by appending a call after restart and checking the exact increase. Add cases for a split UTF-8 line, unknown usage, a truncated or archived file, a fork that replays history, a child agent and a lost acknowledgement. Use synthetic content throughout.

**Engineering artifacts and checks.** The [storage scenarios](local-collector/storage.feature), [TypeSpec contract](local-collector/storage.tsp), [dependency rules](../../.dependency-cruiser.collector.json) and [component manifest](../../apps/collector/component.yaml) accompany the [storage port](../../apps/collector/src/storage/collector-storage.ts) and [in-memory fixture](../../apps/collector/src/testing/in-memory-collector-storage.ts). Run the handoff checks from the repository root with Node 26.13.1 and Bun 1.4.4.

```sh
bun install --frozen-lockfile
bun run check:collector-storage
bun run lint
bun run test
bun run habit-hooks --all
```

Use the storage check as a required CI check before merging the fixture. It exercises the scenarios, checks dependency boundaries, and compiles TypeSpec to JSON Schema. The steps type-check against the handwritten TypeScript port and validate serialized values against the emitted schema. When the HTTP client and server introduce generated wire types, CI should regenerate them, detect drift, and run the same storage cases against the server. Production release work adds the JSONL readers, scanner and remote transport in that order. Pricing, feature or PR attribution and semantic analysis consume these records in later phases.
