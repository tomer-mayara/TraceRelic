# TraceRelic local transcript collector

A developer can read a saved Codex or Claude Code chat and see its measured token use, including
planning chats without code changes. Show the visible conversation, the known total and any gaps. Retain
recorded context for later attribution. Pricing and verification of pull requests belong to a later
delivery.

LC-00a through LC-17 have implementations. This document defines the intended behavior. The
[stack review and repair plan](local-collector-stack-review.md) identifies where the implementation
falls short and gives the next acceptance checks. The
[original ticket decisions](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/docs/specs/local-collector.md#tickets)
are preserved at the reviewed revision.

## Read and select transcripts

| Entry point | Result |
| --- | --- |
| `history --config <file> --from <instant> --to <instant>` | Read raw provider records in the half-open interval `[from, to)`. Compare recorded instants with their offsets. Return the original timestamp and payload, provider, session ID, absolute file and one-based line. Preserve file order and reread the files on each call. Equal bounds return an empty list. The reader raises `RangeError` for invalid or reversed dates and surfaces file read errors. |
| `scan --once --config <file>` | Import complete records and return the selected stored sessions. Repeated `--session` and `--project` selectors form a union. A project matches a recorded working directory in its tree or the exact Claude transcript project directory. Empty selection includes all configured roots. |
| `watch --config <file>` | Run the same import at startup and on a schedule. Emit one small status report per pass. The same selectors apply. |

Load the JSON config once. Relative provider paths start at the config file's directory and `~/` expands
to the user's home. Codex uses `rollout-*.jsonl` and `rollout-*.jsonl.zst` under `sessions/` and
`archived_sessions/`. The header supplies the session ID. Read compressed files at logical uncompressed
byte offsets. Use the recorded path syntax for project matching and preserve the supplied precision of
RFC 3339 date-window bounds. Claude uses project JSONL files and nested `subagents/agent-*.jsonl`. Use the
row's session ID and distinguish an agent that repeats its parent's ID. Scan recognized orphaned and
superseded copies for recovery. Omit
`claudePath` for Codex-only operation. [Configuration](local-collector/config.tsp) ·
[History interface](local-collector/history.tsp) ·
[CLI examples](../../README.md#read-local-codex-and-claude-code-history)

Sessions are scoped to workspace, provider and native session identity. Read positions are scoped to an
installation and a logical transcript. Two installations can share a chat and advance independently. A
verified archive move preserves the logical source. Local configurations without an installation ID
retain their legacy root-based identities. Remote credentials supply the installation. Supplying its
matching ID in the config must address the same remote file. Use the source machine's path rules when
interpreting its recorded locations. [Session key](local-collector/session-key.tsp) ·
[Source and storage contract](local-collector/storage.tsp)

## CLI output and diagnostics

| Constraint | Decision and check |
| --- | --- |
| Behavior | `history` and `scan --once` write their JSON results to stdout. `watch` writes one JSON report per pass. A successful command with no diagnostics leaves stderr empty. Check both streams. [Configuration scenarios](../../apps/collector/test/acceptance/config/local-config.feature) · [Remote scan scenarios](../../apps/api/test/acceptance/collector/remote-sync.feature) |
| Observability | Log pending scans and missing sources at `WARN`. Log rejected batches, unexpected watch failures, and command errors at `ERROR`. Each structured diagnostic keeps its JSON payload as the message. Keep transport details and credentials out of these reports. |
| Architecture | Each CLI invocation owns one `ConsoleLogger` and waits for it to close. The CLI receives scan diagnostics through the scanner's callbacks and errors. [Shared logger](shared-logging.md) · [Dependency checks](shared-logging/dependencies.json) |
| Interface | The stderr prefix includes the UTC timestamp, level, calling file and line. The one-time command exits with 75 for pending work and 1 for a rejection or command error. If stderr fails, keep an existing failure code or return 1. Check the scan schema and CLI tests. [Scan types](local-collector/scan.tsp) · [CLI tests](../../apps/collector/test/integration/scan) |

## Visible conversation

Keep the original text, role, recorded time and position of each visible user or assistant block. Use
native row or item identity and block index when available. A fallback combines stable fields and their
occurrence in verified history. Preserve two genuine identical prompts. Across independent files, equal
text, time or position alone cannot prove a copy. Keep the first verified order within a source. Equal
timestamps across sources establish no order.

Prefer Codex's completed visible user or assistant item when the rollout supplies one. Older rollouts
can pair a `response_item` with a visible `event_msg` mirror. Paginated chats use completed user and
assistant items and respect the assistant item's display decision. Show each block once across batches,
appends and restarts. A verified line prefix can link a joined event to its original native text blocks
across installations. Claude accepts a plain content string or typed text blocks. Its complete generated
`<tick>` and `<goal>` envelopes are omitted. Ordinary text that quotes them remains visible. Omit tool output,
injected system or environment messages, reasoning and attachments from the conversation. An assistant
row containing only tool use may still supply token usage. Keep the turn or request, working directory,
repository and branch that the evidence supports. The most recently recorded branch supplies the session
hint.
[Codex rollout policy](https://github.com/openai/codex/blob/ea8ccc1d20ff65398e02490ac34f8c1012848625/codex-rs/rollout/src/policy.rs#L134-L156)
· [Codex answer display](https://github.com/openai/codex/blob/ea8ccc1d20ff65398e02490ac34f8c1012848625/codex-rs/protocol/src/items/display.rs)
· [Codex conversation scenarios](../../apps/collector/test/acceptance/scan/codex-planning.feature) ·
[Claude conversation scenarios](../../apps/collector/test/acceptance/scan/claude-conversation.feature)

## Measured usage

Sum inclusive input and output for each accepted call or interval owned by the session. Counts and
totals are nonnegative safe integers. Cache reads and writes are disjoint parts of input. Reasoning is
part of output. Assign a turn or model only when the evidence identifies one.

| Accepted measurements | Known gap | Coverage and total |
| --- | --- | --- |
| None | Either | `unknown`, total `null` |
| At least one, including an explicit zero | No | `reported`, sum of measured tokens |
| At least one | Yes | `partial`, sum of known tokens |

Coverage describes saved records. Preserve independently verified data across damage. Record the source,
line number and exact half-open byte range of a problem. A persistent damage gap requires repair. A
missing suffix or unresolved owner can clear when its own evidence is recovered.
[Storage types](local-collector/storage.tsp) ·
[Damaged transcript scenario](../../apps/collector/test/acceptance/scan/preserve-known-usage.feature)

### Codex

A native `token_usage_record` identifies a completed response, its thread and turn, its own usage and
cumulative counters. Use the response identity and retain one measurement when the same work also
appears in `event_msg.token_count`. Legacy rollouts require the following reconciliation.
[Native response usage](https://github.com/openai/codex/blob/ea8ccc1d20ff65398e02490ac34f8c1012848625/codex-rs/protocol/src/protocol.rs#L2625-L2637)
· [Counter scenarios](../../apps/collector/test/acceptance/scan/codex-token-counts.feature)

1. Start from zero only for a verified fresh session. In a fragment, retain independently identified
   calls and use the first reliable snapshot as the baseline. Flag the unknown range. An empty
   rate-limit update preserves the baseline.
2. Compare cumulative input and output separately. Subtract calls already counted since the baseline.
   Attribute a verified last call once and put the remainder in an interval. A rise from 120 to 200 adds
   80 in all, including a 30-token last call. A repeated snapshot adds zero. Keep reliable counts when
   an optional breakdown is uncertain.
3. A last-call-only record needs distinct call evidence. A second identifier for an existing call
   preserves its identity. After a reset, possible counter break or uncertain overlap, retain
   independent calls, mark the gap and establish a new reliable baseline.
4. Replace a coarse interval with its detailed parts atomically when both boundaries identify the same
   history and the parts conserve input and output. Retain that detail on later coarse replays. Withhold
   disputed overlap. Equal counters alone cannot match histories across a possible reset.

### Claude Code

Inclusive input is `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. A complete
duration breakdown can supply the cache-write count if the flat field is absent. Add output once.
Top-level usage includes executor iterations. Each distinct advisor iteration contributes one separate
measurement within the request. A later provider identifier for that same ordered iteration preserves
its measurement.
[Claude usage scenarios](../../apps/collector/test/acceptance/scan/claude-usage.feature) ·
[Usage report contract](local-collector/storage.tsp)

Match message and request IDs together. A lone ID must identify a single call. Compare whole reports. A
final report supersedes a provisional one even if the amount falls. Accept a provisional increase
with the same reported fields when at least one count rises and none falls. Accept an added breakdown
when the known counts agree. Keep the original call ID, time and order when advancing the revision.
Exclude a disputed amount and flag the gap while retaining independently confirmed measurements.
Equivalent observations must yield the same measured amount and provisional or final status in either
order. Replaying an accepted observation leaves its revision stable.

### Forks and subagents

Keep child conversation text in the child session. Charge a call once to its verified owner. Record the
parent and earliest uncertain position so later evidence can resolve ownership. An ownership transfer
updates both session versions together.

For Codex, use the child's own thread header. Prefer recorded response ownership and a verified native
fork position where available. Older rollouts require matching the ordered parent and child reports at
the fork, allowing copied outer timestamps to change. Use the last matched parent counters as the
inherited baseline. A zero or a verified first call that accounts for the full counter can establish a
fresh child counter. A shorter compatible parent copy preserves an already proven boundary. A genuine
contradiction reopens the disputed range. Missing, unselected or cyclic parents cannot establish new
ownership. [Codex fork scenario](../../apps/collector/test/acceptance/scan/codex-fork.feature) ·
[Provider fork metadata](https://github.com/openai/codex/blob/ea8ccc1d20ff65398e02490ac34f8c1012848625/codex-rs/protocol/src/protocol.rs#L3560-L3569)

For Claude, match a cited original row and its model message identity, or match the full message and
request IDs in the linked parent. This allows a fork to remap row or request IDs and keeps independent
requests that share a model message ID distinct. Once the request owner is verified, a copied final or a
newly observed advisor iteration can update that owner. A parent-only scan can resolve earlier child
evidence. [Claude fork scenario](../../apps/collector/test/acceptance/scan/claude-fork.feature) ·
[Provider fork transform](https://github.com/anthropics/claude-agent-sdk-python/blob/69846cdf82aef59add3b14a26b4f16d1ccee26ba/src/claude_agent_sdk/_internal/session_mutations.py#L405-L442)

## Resume, recover and report

1. Bind selection, session identity and the byte extent to the same captured file contents. Read
   complete newline-terminated UTF-8 records only through that extent. A genuine append waits for the
   next pass. An incomplete last line, including a split UTF-8 character, stays unread until its
   newline. A malformed complete record gets a diagnostic and later valid records remain readable.
2. A checkpoint records the next byte, physical line, SHA-256 prefix digest and versioned parser state.
   Verify the entire accepted prefix and any later `replayThrough` boundary used to resolve ambiguous
   occurrences. Verify multiple positions in one streaming pass per file where possible. Preserve the
   known positions on a verified append or move. Replay a changed generation from zero and retain
   previously accepted records. Reserve ambiguous fallback IDs across replay and restart. Upgrade older
   state from verified bytes. Existing checkpoints can carry version 3 occurrence reservations and a
   version 4 Codex gap awaiting a reliable baseline. Preserve an unsupported newer checkpoint and report
   its source and byte. [Scan contract](local-collector/scan.tsp) ·
   [Rewrite scenario](../../apps/collector/test/acceptance/scan/recover-changed-transcript.feature)
3. Commit records, measurements, metadata, parser state and checkpoint together. Check both session
   version and source offset, even when two sources write to one session or a rewritten file reaches the
   same offset twice. A new session starts at version zero. A repeated immutable message must agree on
   content. Usage corrections advance the revision. A rejected batch has no partial effects.
   [Storage contract and scenarios](../../apps/collector/test/acceptance/storage/storage.feature)
4. After conflict or lost reply, reread the stored checkpoint and verify the winning bytes before
   rebuilding a batch. Bound retries at an unchanged position. On an invalid batch, stop that physical
   file for the pass and skip further copies of the rejected stream. Preserve earlier commits and
   continue independent files, including other streams in the same session. In one-time mode,
   success exits 0. Rejection prints accepted sessions and exits 1. Unconfirmed work reports its source
   or selection, range when known and retry time, and exits 75 even following a rejection.
   [Lost reply](../../apps/collector/test/acceptance/scan/retry-lost-connection.feature) ·
   [Rejected batch](../../apps/collector/test/acceptance/scan/isolate-rejected-batch.feature)
5. Confirm disappearance across the selected root and possible archive locations. An unreadable
   directory, incomplete identity or unverified filename cannot establish a loss or recovery. Report a
   disappearance once, with the accepted byte and greatest complete end proved for that generation.
   Coverage stays measured when the two match. A proved unread suffix makes a measured total partial. On
   return, restore presence and independently verify recovery of any gap. In-process evidence can cover
   a file lost before its first upload. After restart, a missing file must have an acknowledged
   inventory entry.
   [Missing-source scenario](../../apps/collector/test/acceptance/scan/missing-source.feature)

On the first verified scan of an older checkpoint, re-decode the accepted prefix and replace that
source generation's messages, metadata and usage in one version-checked write. Keep replay reservations
and independent source contributions. Mark the checkpoint with `evidenceVersion: 1`. When a current
native Codex session proves an old message was filed in the wrong session, compare both source versions
and the corroborating message positions before removing the old contribution. Keep any unverified
measurements and report `unverified-source-history` against the original source. A missing or replaced
legacy generation also carries that diagnostic when its records cannot be verified. An empty legacy
decoder at a positive byte offset qualifies when the recorded source identifies a scanner file. A
cross-session text correction also needs the physical line boundary of the accepted generation.
When re-reading a Claude backup, preserve the working directory, repository and parent session fields
it originally supplied and their order relative to other sources. Select branch observations by their
recorded time and line.

`watch` uses a 60,000 ms default interval, allows one active pass and skips elapsed ticks. Preserve
pending age until work is resolved. Honor the longest applicable retry deadline, including a valid
`Retry-After`. A rejected or failed pass uses the next regular interval. On shutdown, finish the active
pass. Keep source diagnostics on standard error and report status, newly confirmed sessions, oldest
pending age and an applicable retry time on standard output.
[Scheduled scan](../../apps/collector/test/acceptance/scan/scheduled-scan.feature) ·
[Report types](local-collector/scan.tsp)

## Remote storage and verification

The standalone collector can use process-local memory. Remote scans use the same storage port over
HTTPS, with HTTP also permitted on loopback. Both API origin and bearer token are required in remote
mode. Authenticate before processing the request body. The credential selects the workspace and
installation. Sessions are shared within the workspace. Checkpoints and inventory are
installation-scoped. An explicit workspace selector or conflicting installation receives 400. Invalid or
expired credentials receive 401. The client stops on 401 or 403. On a dropped connection, read the
checkpoint immediately to confirm the write. For a 429 or temporary HTTP server error, wait at least
one second and honor a longer valid `Retry-After`. Each request can carry up to 1 MiB of encoded JSON.
Large batches can reference verified ranges of the stored parser state or stage parts under the same
credential. Check both the transferred and reconstructed bytes at finalization, then atomically commit
the whole batch. Uncommitted parts expire after one day. Continue other files after an indivisible oversized record.
[HTTP contract](collector-api/main.tsp) ·
[Remote sync](../../apps/api/test/acceptance/collector/remote-sync.feature)

Only the API connects to PostgreSQL. Apply migrations before listening. Store sufficient evidence to
restore corrections and ownership after restart. In one transaction, compare the session version and
source offset and commit records, ownership, presence and checkpoint. Stale competing writers get a
conflict, including on first insert. A failed transaction leaves the previous state available for retry.
Repeated acknowledged presence at its current version keeps the version stable. Project only record
inserts, updates, order changes and removals. A cold writer rebuilds ownership from the journal.
Replay previously accepted writes with their original session versions and ownership decisions. A
collector's verified repair can then change the affected sessions together. An unrelated write after
an API upgrade must succeed while earlier chats retain their accepted records and totals.
An ordinary presence update only changes the summary and source inventory. Record commit outcome,
authenticated scope and duration. Keep chat text, credentials and connection strings out of operational
logs. A production service target awaits measurements.
[Restart](../../apps/api/test/acceptance/postgres/restart.feature) ·
[Competing writes](../../apps/api/test/acceptance/postgres/competing-writes.feature) ·
[Rollback](../../apps/api/test/acceptance/postgres/write-rollback.feature)

Use synthetic files, loopback HTTP and a disposable PostgreSQL database. The cross-provider check
expects Codex 200 and Claude 131 after replay and restart, then 230 and 131 after one append, with each
conversation block appearing once. Run the published CI checks under the pinned Node and Bun versions.
The component manifests list the executable scenarios, interfaces and dependency rules.
[Two-chat check](../../apps/collector/test/acceptance/scan/two-chats.feature) ·
[Collector manifest](../../apps/collector/component.yaml) ·
[API manifest](../../apps/api/component.yaml) · [PR checks](../../.github/workflows/collector.yml)
