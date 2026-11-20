# TraceRelic local transcript collector

A developer can read a saved Codex or Claude Code chat and see how many tokens it used. A planning chat counts even if it never edits a file. Show the measured total, the text, and any known gap. Keep enough evidence to link a turn to a feature or pull request later.

**First delivery.** Build one local scanner. Test it against the existing in-memory storage fixture. **Remote delivery.** Send the same records to the TraceRelic API. The API owns the database. Supabase Postgres is a candidate. Pricing, PR detection, and feature attribution come later.

## First end-to-end scenario to implement

```gherkin
@two_chats
Feature: Read token use for a planning chat
  Scenario: A restart preserves both chats and picks up new work
    Given a Codex planning chat has cumulative totals of 120, 120 and 200
    And one Claude request has 40 input tokens and reports 2 then 91 output tokens
    When I scan twice and restart the collector against the same storage
    Then the totals are 200 for Codex and 131 for Claude
    When I append a 30-token Codex call and scan again
    Then the totals are 230 for Codex and 131 for Claude
    And each original text block appears once in its chat
```

## What to read

**Codex.** Under the configured `codexPath`, find `rollout-*.jsonl` in `sessions/` and `archived_sessions/`. Read the ID from `session_meta.payload.id` or `session_id` in the same payload. A move to the archive keeps the same source. [Rollout discovery](https://github.com/git-ai-project/git-ai/blob/5420ab9081d2cd57ffdafced09a8028d6dabf4bd/src/streams/agents/codex.rs#L96-L125)

**Claude Code.** Under the configured `claudePath` (usually `~/.claude`), read `projects/<project>/<session>.jsonl` and `projects/<project>/<session>/subagents/agent-*.jsonl`. Read `sessionId`. For a subagent, also read its agent ID from the record or filename. Orphaned and superseded transcripts are earlier copies. Use them to recover identifiable records in the same session. Skip tool-result files and prompt history. [Claude directory layout](https://code.claude.com/docs/en/claude-directory) · [Subagent files](https://code.claude.com/docs/en/sub-agents)

The local CLI takes a JSON file with `--config <file>`. At startup it loads one `GlobalConfig` and passes it to the readers. Relative provider paths start at the directory containing the file. The supplied configuration selects `~/.codex` and `~/.claude`. A configuration with only `codexPath` reads only Codex. [Local configuration](../../tracerelic.config.json) · [Configuration contract](local-collector/config.tsp)

Map selected projects, sessions, or a whole provider root to the destination workspace. A provider home can contain chats for more than one workspace. A selected chat can have no Git metadata.

**Session identity.** Use the workspace, provider (`codex` or `claude`), and native session ID. If a Claude child repeats its parent's ID, encode the parent and agent IDs as a distinct child key.

**Source identity.** Also identify the installation and logical transcript. The configuration or credential supplies a stable installation ID. Two installations that read the same chat have separate read positions and share one session. A path can change when a file moves.

**Chat text.** Keep the original text, role, and recorded time for each user or assistant block. For Codex, read visible chat messages and handle formats with paired `response_item` and `event_msg` copies. Keep one copy. For Claude, accept both a plain `message.content` string and an array of typed blocks. A tool-only response can carry usage. Read usage even when there is no chat text to save. Exclude tool output, system instructions, injected environment data, hidden reasoning, and attachments from the conversation. [Codex message fixture](https://github.com/git-ai-project/git-ai/blob/5420ab9081d2cd57ffdafced09a8028d6dabf4bd/tests/fixtures/codex-session-simple.jsonl) · [Claude message fixture](https://github.com/git-ai-project/git-ai/blob/5420ab9081d2cd57ffdafced09a8028d6dabf4bd/tests/fixtures/example-claude-code.jsonl)

**Message order.** Within a source, order blocks by record number and block index. Keep the first verified position on replay. Equal timestamps across independent sources establish no order.

**Repository context.** Store the turn or request ID, working directory, repository and branch that the transcript gives for the record. Leave missing fields unknown. For a session's branch hint, use the most recent recorded branch. Replaying an old turn cannot replace it. Chat text can suggest a PR. To verify that it opened, a later phase can capture a Git host event or a successful tool result with the PR ID.

## How to count tokens

Sum inclusive input and output over the latest accepted measurements owned by the session. Give each measurement a stable ID. Record whether it covers one provider call or an interval between two snapshots. Assign a turn or model only when the evidence identifies it. Count an explicit zero. A missing measurement has no numeric value.

| Stored measurements | Known gap | Session view |
| --- | --- | --- |
| None | Either | `unknown`, total `null` |
| At least one | No | `reported`, sum of measured tokens |
| At least one | Yes | `partial`, sum of the known tokens |

`reported` describes the records TraceRelic could read. A chat the provider never saved is outside that coverage. The fixture keeps a gap once recorded. A later scan can add verified measurements. Clearing a recorded gap requires a full repair in a later phase.

### Codex

Read `event_msg` records of type `token_count`. Use `turn_context` for the model when available. `info.total_token_usage` is cumulative. `info.last_token_usage` describes the last call. Cached input is part of input. Reasoning output is part of output. If only a cache breakdown is unclear, keep the reliable input and output and leave the breakdown unknown. An empty `info` on a rate-limit update adds no measurement. [Codex token-count fixture](https://github.com/git-ai-project/git-ai/blob/5420ab9081d2cd57ffdafced09a8028d6dabf4bd/tests/fixtures/codex-session-token-count.jsonl)

1. Start at zero only for a verified fresh session. For a file that starts mid-session, keep independently identified calls. Use the first reliable snapshot as the baseline and flag the unknown earlier range. Save the baseline with the checkpoint.
2. Compare cumulative input and output with the previous baseline. An identical snapshot adds nothing. Subtract any identified calls already counted in that interval. Apply the same check to comparable breakdowns.
3. Record the last call if it belongs to this change and has not already been counted. Record any remaining difference as an interval. If only cumulative counts exist, store just the interval.
4. A last-call-only report needs evidence that it is a new call. Two calls can report equal amounts. If counters fall or measurements overlap in an unknown way, keep the independently verified calls. Flag the gap and start a new baseline.

**Example.** Cumulative usage moves from 120 to 200. The last call used 30. The session gained 80 tokens. Attribute 30 to that call and 50 to the interval. If 20 of those 50 were already recorded from an identified call, add only the other 30 to the interval. The final total is 200 in both cases.

Two copies can describe the same interval at different levels of detail. Keep the start and end counters from the same verified history. When a second copy identifies calls inside an accepted interval, replace just that interval with its parts in one write. Their input and output must sum to the original counts. Ignore a later replay of the coarse interval. If the histories cannot be matched, flag the overlap and omit the disputed addition.

### Claude Code

Read `message.usage` on assistant records. Add `input_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens` to get inclusive input. Add `output_tokens` once. Cache-write durations partition the write count. Use their sum if the flat field is absent and the breakdown is complete. For advisor use, the top-level counts include executor iterations. Add each separate `advisor_message` iteration once under its own stable ID. An unsupported breakdown gets a diagnostic. [Claude cache fields](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) · [Advisor usage](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool#usage-and-billing)

Group updates by `message.id` and `requestId`. If one is missing, match the other only when it identifies one call. Keep the same call ID when the missing field appears later. Use the transcript row's `uuid` and the block index for chat text. One model request can produce several rows.

Compare whole reports for the same call. A provider completion signal takes priority over a provisional report, even when the final count is lower. Among provisional reports with the same fields, accept an update if no count falls and at least one rises. Accept an added breakdown when the known counts agree. Ignore a repeated or older report.

If neither report has priority, keep any independently confirmed measurement. Withhold a disputed provisional measurement from the total and mark a gap. Replaying either disputed report must give the same result. On a correction, read the current stored measurement, keep its original call ID, time and order, and increase its revision once.

### Replays, forks and subagents

Prefer native record IDs. Without one, use the record's stable fields and its occurrence in the verified source history. Include the block index for text. This preserves two identical prompts at different positions. An offset or occurrence count can change after a rewrite. Reuse a fallback ID only where the old and new histories can be matched. Keep accepted records and flag an ambiguous range.

Keep child text in the child chat. Charge each call only to the session that made it. For Codex, use the child's own session header. Match the inherited prefix at the fork point before counting the child. For Claude, check both ordinary forks and subagents. A fork can remap transcript UUIDs. Use provider call IDs or a verified copy boundary. Check available, selected parent files even if discovery finds the child first. Save the earliest uncertain position and parent ID so a later scan can revisit it when new evidence arrives. When ownership cannot be established, keep the chat text and report the gap. Count only calls with a known owner. [Codex fork evidence](https://github.com/git-ai-project/git-ai/blob/5420ab9081d2cd57ffdafced09a8028d6dabf4bd/src/token_usage/codex.rs#L569-L589) · [Claude session forks](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser)

## Scan and storage

Use one scan operation under `apps/collector`. The command `scan --once` runs it once. The scheduled collector calls it at startup and at each interval. Each provider adapter reads its own format. The scanner sends batches through `CollectorStorage`. Tests inject the fixture. In remote mode the scanner uses a scoped TraceRelic credential over HTTPS. Only `apps/api` connects to the database.

1. Discover the selected files. Open each file, identify its source and record its current end. Load its checkpoint. This gives the next unread byte, parser state, parser version and digest of the accepted bytes.
2. Verify the accepted prefix before resuming a changed or reopened file. Stream the check once per file per scan. A matching tail can hide a change in the middle. Resume a verified append or archive move at the saved byte. On truncation, a changed prefix, or an older state the parser can rebuild, replay from zero. Use the same replay when new parent evidence resolves an earlier range. Keep accepted history. Pause and report a state that needs a newer parser.
3. Read complete, newline-terminated UTF-8 records up to the end recorded in step 1. Leave an unfinished line for the next scan. For a malformed complete line, record the source and byte range, flag any possible usage gap, and continue. If a file is replaced or truncated during a read, discard the pending batch and reload the checkpoint.
4. Save records, parser state and checkpoint in one write. On `conflict` or a lost reply, reload the stored version and checkpoint before retrying. On `invalid`, leave the checkpoint in place, report the rejected range, and continue with other files. A one-time scan reports pending work and returns. The scheduled collector retries with a delay. Neither mode needs a local transcript database.

### Existing fixture and planned changes

`readCheckpoint(source)` returns the session version and the source checkpoint. A new session starts at version zero. A source that has never committed has a null checkpoint. `commit(batch)` compares both `expectedVersion` and `expectedOffset`, requires the next offset to advance, and increments the session version on success. `readSession(key)` returns the stored messages, latest usage per ID, metadata, total and coverage. A fixture instance represents one workspace. Keep that instance alive when a test restarts the scanner. [Storage interface](../../apps/collector/src/storage/collector-storage.ts) · [In-memory fixture](../../apps/collector/test/fixtures/in-memory-collector-storage.ts) · [Storage contract](local-collector/storage.tsp)

Keep the existing outcomes `committed`, `conflict` and `invalid`. Require RFC 3339 timestamps and nonnegative safe integer counts, including the session total. Cache reads and writes are disjoint parts of inclusive input. Reasoning is part of output. An identical message is safe to replay. Conflicting content under an immutable message ID rejects the batch. A higher usage revision replaces the prior observation. Equal revisions must agree. An invalid batch changes nothing.

| Ticket | Contract change to make before implementing the behavior |
| --- | --- |
| LC-01 | Add optional source order, block index, turn or request ID, and recorded context. Support earlier records that lack these fields. |
| LC-03, LC-06 | Keep one current checkpoint per installation and logical source. Return the session version even for a new source. Start a new session at version zero. Normal appends advance the offset. Only an explicit reset can rewind it. |
| LC-04, LC-05 | Distinguish calls from intervals. Support atomic replacement of a verified interval by its parts. Keep a call's final or provisional status when known. Exclude a disputed measurement from the total until evidence resolves it. Older measurements with no type establish no call-to-turn link. |
| LC-10, LC-11 | Where a provider call ID is reliable across sessions, store one workspace-wide owner for that call. A confirmed replay adds nothing. If later evidence changes the owner, move the single measurement and update both session versions together. Leave uncertain calls unassigned unless an owner is already proven. |
| LC-12 | List the sources previously acknowledged for the installation and selected roots. Save source presence at the existing byte with the same version check. Track the highest complete byte known to exist when available. Repeating the same status is harmless. |

An offset tells the reader where to start. A version tells storage whether a writer is stale. Each writer reads the session version before looking up existing records. Storage checks that version, applies the batch, and increases the version in one transaction. On conflict, reread both the checkpoint and the affected records. This protects a correction from another source in the same session. It also rejects a delayed write after a rewritten file reaches byte 420 a second time.

**If a file disappears.** First check its possible active and archive locations. A failed directory read does not establish that a file was removed. Report a confirmed missing source once, with its last accepted byte. If the collector had seen more complete bytes, flag the gap and keep the known total. If storage had accepted everything seen, keep the measured coverage and report the missing source separately. A later sighting restores presence. During an outage the running scanner can report a file it saw before the first upload. After a restart, only acknowledged sources can be identified if the files are gone.

## Delivery and verification

Use synthetic files in a temporary directory. Run the scanner against the fixture without credentials, a network connection, or a database. For API tests, start a local server with two test credentials and one fixture instance per workspace. Use a disposable database for the durable adapter tests.

Track new sessions, rejected lines and batches, known gaps, version conflicts, and the age of the oldest pending source. Log identifiers and byte ranges. Keep chat text in the stored conversation. At the API, measure commit outcomes and latency. Set a production service objective after measurements exist.

Use the repository's pinned Node and Bun versions. Run the checks below from the repository root. The storage check builds the project, compiles TypeSpec, checks dependency rules, and runs the storage scenarios. When the client and API share generated models, check in CI that they match TypeSpec. [Storage scenarios](../../apps/collector/test/acceptance/storage/storage.feature) · [Component manifest](../../apps/collector/component.yaml) · [Dependency rules](../../.dependency-cruiser.collector.json) · [Repository checks](../../README.md#run-the-checks)

```sh
bun install --frozen-lockfile
bun run check:collector-history
bun run check:collector-storage
bun run check:collector-scan
bun run test
bun run lint
bun run habit-hooks --all
```

The scan check runs token corrections, chat imports and growing-file scenarios. Its `@two_chats` scenario checks both providers' totals before and after a restart and append.

## Tickets

LC-00a through LC-00c deliver local history reads by date. LC-01 through LC-05 connect the readers to the storage fixture and report totals for ordinary chats. LC-06 through LC-13 cover recovery, child sessions and scheduled scans. LC-14 through LC-17 deliver remote storage.

1. Put the ticket scenario in a Cucumber `.feature` file. Run it through the public entry point used by callers. Bind the steps before recording the first failing assertion. LC-00a starts with the reader method. LC-01 adds the command scenarios and binds `@two_chats`. Make that cross-provider check required once LC-04 and LC-05 both pass.
2. Before coding, record the behavior, operational signal, dependency rule and interface affected by the ticket. Update the relevant TypeSpec, component manifest and dependency checks. [Feature planning](../engineering-guidelines/new-feature-planning.md)
3. Take one numbered test at a time. Run it and see it fail for the stated reason. Make the smallest change that passes it. Refactor while it passes. Rerun the supporting tests and the acceptance scenario. A ticket is done when its scenario and previously delivered cases pass. Keep a case that already passes as a regression test. [Test levels and TDD](../engineering-guidelines/coding-principles.md)

### Local chat history by date

`LocalLLMHistory` is an abstract class that declares `readLocalHistory(fromDate: Date, toDate: Date)`. Its concrete subclasses are `LocalLLMHistoryCodex` and `LocalLLMHistoryClaude`. Share the date filter. Each subclass reads its provider's file format.

The method returns a promise of a read-only list. Each entry identifies the provider (`harness`), session, source file and original line number. It includes the recorded timestamp and parsed provider record. Keep original message content and usage fields. LC-01 and LC-02 select visible chat text. LC-04 and LC-05 calculate token totals.

Include each complete record whose timestamp is **at or after** `fromDate` and **before** `toDate`. Compare instants, including any UTC offset. A session can start before the range and still contain matching records. Read earlier metadata as needed to identify the session. Keep file order within each source. Each call reads the local files independently of storage or sync checkpoints.

The scenarios in these three tickets are interface tests. Bind each `When` step to the public method on a real subclass held as a `LocalLLMHistory`. Give each test its own temporary provider root with synthetic JSONL files. Use the same date assertions for both subclasses. [Transcript locations and formats](#what-to-read)

#### LC-00a · Read a Codex chat by date

```gherkin
@lc00a
Feature: Read local Codex history
  Scenario: A chat continues past the day its rollout was created
    Given the Codex rollout for "c1" starts on January 31 and contains these messages
      | recorded at              | text         |
      | 2026-01-31T23:59:59.999Z | Earlier      |
      | 2026-02-01T00:00:00.000Z | Plan search  |
      | 2026-02-01T12:00:00.000Z | Use an index |
      | 2026-02-02T00:00:00.000Z | Next day     |
    When I read history from "2026-02-01T00:00:00Z" to "2026-02-02T00:00:00Z"
    Then I get only "Plan search" and "Use an index" in that order for "codex/c1"
```

**Needs** synthetic Codex files. **First failure** The date query misses a matching message in the January rollout or includes the message at the end of the range.

1. **Interface.** Start with one `session_meta` header and one `response_item` message. Call `LocalLLMHistoryCodex` through the abstract type. Assert the session ID, recorded time and original payload.
2. **Interface.** Run the four-row example in an active rollout and then in the archive. Put the file's modification time outside the range. Include an in-range `token_count` record in a separate case and check that its provider fields survive.

| LC-00a constraint | Decision and check |
| --- | --- |
| Behavior | Read complete Codex records in the requested window from active and archived rollouts. Run the [date scenario](../../apps/collector/test/interface/history/codex-history.feature) with `bun run check:collector-history` and the interface tests with `bun run test`. |
| Observability | Each result gives the caller the original timestamp, source path and line number. A failed file read surfaces its filesystem error. This local method has no service objective. |
| Architecture | The reader uses local files and the shared harness identity. The [dependency check](../../.dependency-cruiser.collector.json) keeps it independent of storage and the API and rejects production imports of test code across workspaces. Run `bun run check:collector-deps`. |
| Interface | The [history contract](local-collector/history.tsp) defines the date arguments and the original provider record with its source position. The [collector manifest](../../apps/collector/component.yaml) lists the boundary. `bun run check:collector-history` compiles the TypeSpec and TypeScript and checks returned entries against the emitted schema. |

| Local startup constraint | Decision and check |
| --- | --- |
| Behavior | `collector history --config <file> --from <instant> --to <instant>` reads the selected provider root and writes the matching entries as a JSON array. Run the [startup scenarios](../../apps/collector/test/acceptance/config/local-config.feature) with `bun run check:collector-history`. |
| Observability | A startup error writes a diagnostic to standard error and exits with a failure status. Config file errors identify the file. Invalid settings identify the field. The startup scenarios check these signals. |
| Architecture | The CLI loads the file once. Readers receive the resulting `GlobalConfig` through their constructors. The [dependency check](../../.dependency-cruiser.collector.json) keeps file loading outside the history reader. |
| Interface | The [TypeScript file schema](../../apps/collector/src/config/global-config-schema.ts) defines the JSON fields and validates them at startup. The [published contract](local-collector/config.tsp) describes the same inputs. The loader resolves `codexPath` before constructing `GlobalConfig`. Run `bun run test` for loader behavior and `bun run check:collector-history` for schema agreement and the CLI. |

Opening a pull request, marking it ready for review, reopening it, or pushing new commits runs the workspace Node tests and the collector history, configuration, and storage scenarios. GitHub Actions reports each test group in the pull request check. [PR test workflow](../../.github/workflows/collector.yml)

#### LC-00b · Read Claude Code chats through the same interface

```gherkin
@lc00b
Feature: Read local Claude Code history
  Scenario: Two selected projects have messages in the same hour
    Given Claude Code project transcripts contain these records on February 1, 2026 UTC
      | session | time     | role      | text         |
      | h1      | 09:59:59 | user      | Earlier      |
      | h1      | 10:00:00 | user      | Plan search  |
      | h2      | 10:30:00 | assistant | Use an index |
      | h2      | 11:00:00 | user      | Later        |
    When I read history from "2026-02-01T10:00:00Z" to "2026-02-01T11:00:00Z"
    Then I get only "Plan search" for "claude/h1" and "Use an index" for "claude/h2"
```

**Needs** LC-00a. **First failure** The Claude reader misses a project or attributes its record to the wrong session.

1. **Interface.** Run the LC-00a date assertions against `LocalLLMHistoryClaude` with native Claude fixtures. Check a plain user string and an assistant row with content blocks and `message.usage`.
2. **Interface.** Read two project files through one configured Claude root. Add a nested subagent file that repeats its parent's `sessionId`. Check that the child has its own session key.

| LC-00b constraint | Decision and check |
| --- | --- |
| Behavior | Read records from all projects under the configured Claude root within the same half-open date window as Codex. The CLI returns records from the configured providers. Run the [two-project scenario](../../apps/collector/test/interface/history/claude-history.feature) and the [startup scenarios](../../apps/collector/test/acceptance/config/local-config.feature) with `bun run check:collector-history`. |
| Observability | Each result includes the original timestamp, file path and one-based line number. Filesystem errors reach the caller. Run the reader interface tests with `bun run test`. |
| Architecture | Both readers receive the resolved configuration and share the date filter and complete JSONL record reader. The existing [dependency rules](../../.dependency-cruiser.collector.json) apply to both. Run `bun run check:collector-deps`. |
| Interface | The [config contract](local-collector/config.tsp) adds an optional `claudePath` with the same path rules as `codexPath`. The [history contract](local-collector/history.tsp) retains the original Claude row, including its content and usage. A child that repeats its parent's session ID uses a key formed from both the parent and agent IDs. Run `bun run check:collector-history` for the [collector manifest](../../apps/collector/component.yaml) scenarios and schema checks. |

#### LC-00c · Check date boundaries and repeat reads for both providers

```gherkin
@lc00c
Feature: Use adjacent history windows
  Scenario Outline: A midnight message belongs to one day
    Given a <provider> transcript records "Midnight" at "2026-02-01T19:00:00-05:00"
    When I read February 1 UTC and February 2 UTC as separate one-day windows
    Then only the February 2 result contains "Midnight"
    And reading the two days together returns that record once

    Examples:
      | provider    |
      | Codex       |
      | Claude Code |
```

**Needs** LC-00a and LC-00b. **First failure** Adjacent windows lose or duplicate their shared boundary record.

1. **Interface.** Run the same cases on both readers. An empty root, a range with no matches, and equal endpoints each return an empty list. An invalid `Date` at either end or a reversed range rejects with `RangeError`.
2. **Interface.** Read an unfinished final line. The first query omits it. Append the newline and repeat the query twice. Each later result contains the record once in source order.
3. **Interface.** Give the reader a regular file as its configured root. The call reports the filesystem error. This distinguishes a failed read from a successful empty result.

| LC-00c constraint | Decision and check |
| --- | --- |
| Behavior | Both providers assign a midnight record to the day that starts at that instant. Run the [adjacent-window scenario](../../apps/collector/test/interface/history/history-windows.feature) with `bun run check:collector-history`. Run `bun run test` for empty windows and reads before and after a writer finishes a line. |
| Observability | A successful empty read returns an empty list. Invalid dates raise `RangeError`. A regular file used as a provider root raises a filesystem error. The shared interface tests check each outcome on both readers. |
| Architecture | Each query reads the provider files independently of storage. The existing [dependency rules](../../.dependency-cruiser.collector.json) cover both readers. Run `bun run check:collector-deps`. |
| Interface | The [history contract](local-collector/history.tsp) specifies equal endpoints and the newline that completes a record. The [collector manifest](../../apps/collector/component.yaml) includes the two-provider scenario in the existing history check. |

### Fixture-backed collector

#### LC-01 · Read a Codex planning chat

```gherkin
@lc01
Feature: Import visible Codex chat text
  Scenario: A chat has no edits or token counts
    Given a selected Codex session contains the prompt "Plan search" and the reply "Start with ranking"
    When I scan its root once
    Then its session contains both messages in source order with their roles and recorded times
    And its token total is null with unknown coverage
```

**Needs** LC-00c and the storage fixture. **First failure** The session is absent after the scan.

1. **Interface.** Put rollouts in active, archive and unselected locations. Check root precedence and workspace selection. Discover only the selected sources.
2. **Unit.** Give two blocks the same timestamp and mirror a message in both event formats. Keep the original order and one visible copy. Check a missing branch and a later branch switch.
3. **Integration.** Reuse the Codex reader's discovery and decoding in the real `scan --once` handler. Read the stored chat through `readSession`.

| LC-01 constraint | Decision and check |
| --- | --- |
| Behavior | `collector scan --once --config <file>` reads active and archived Codex rollouts. Repeat `--session <id>` or `--project <directory>` to select sessions for the destination workspace. Either match selects a session. With neither option the command selects the configured root. The [planning chat scenario](../../apps/collector/test/acceptance/scan/codex-planning.feature) and the [two-chat scenario](../../apps/collector/test/acceptance/scan/two-chats.feature) run in `bun run check:collector-scan`. |
| Observability | The command writes the selected session views as JSON. A planning chat with no measurements has unknown coverage and a null total. Storage rejections identify the source and attempted byte range. The command and storage checks exercise these outcomes. |
| Architecture | One scanner uses the [Codex reader](../../apps/collector/src/history/local-llm-history-codex.ts) and the [storage port](../../apps/collector/src/storage/collector-storage.ts). Each injected storage instance represents one workspace. The standalone command uses process-local memory for this delivery. The [dependency rules](../../.dependency-cruiser.collector.json) keep the storage implementation outside the scanner. Run `bun run check:collector-deps`. |
| Interface | The [scan contract](local-collector/scan.tsp) defines source selection, the Codex reader's complete records and byte positions, and the stored session results. The [storage contract](local-collector/storage.tsp) adds optional message positions, turn and request IDs, recorded context and the position of a branch observation. An undated branch change has an order within its source. A branch from another source supersedes the current hint only when recorded times establish which came later. Earlier batches can omit the new fields. Run `bun run test`, `bun run check:collector-storage` and `bun run check:collector-scan`. |

#### LC-02 · Read Claude Code text blocks

```gherkin
@lc02
Feature: Preserve Claude Code conversations
  Scenario: Two turns contain the same prompt
    Given a Claude session contains "Why?" twice and one assistant response has two text blocks
    When I scan its project twice
    Then both prompts appear and both answer blocks appear once in their original order
```

**Needs** LC-01. **First failure** The Claude text is missing or the two prompts collapse into one.

1. **Unit.** Decode a plain string and a block array. Use the row UUID and block position when present. Test identical prompts, tool results and images separately.
2. **Integration.** Scan mixed roots with equal Codex and Claude session IDs. Read two separate sessions. Verify an orphaned copy does not create a third session.

| LC-02 constraint | Decision and check |
| --- | --- |
| Behavior | Running `scan --once` twice preserves two identical prompts and each visible answer block in source order. The Claude row UUID and original block index identify text across copies. Within a single source, rows without a UUID use stable fields and an occurrence number. The [conversation scenario](../../apps/collector/test/acceptance/scan/claude-conversation.feature) runs in `bun run check:collector-scan`. |
| Observability | The command returns one session view per provider and session ID. An earlier copy with no recoverable records adds no session. Raw tool output, thinking and attachments stay out of the conversation. Until token accounting is available, Claude text has unknown coverage and a null total. Run `bun run test` for stored views and replay. |
| Architecture | The existing scanner reads the configured Claude projects through the [Claude history reader](../../apps/collector/src/history/local-llm-history-claude.ts) and commits through the [storage port](../../apps/collector/src/storage/collector-storage.ts). The existing [dependency rules](../../.dependency-cruiser.collector.json) cover both providers. Run `bun run check:collector-deps`. |
| Interface | The [scan contract](local-collector/scan.tsp) adds Claude transcripts with their native session identity, source positions and prior-copy flag. Select a session by its first recorded working directory or the exact transcript project directory. Earlier copies of that selected file can recover identifiable rows for the same session even if its working directory changed. The storage contract already carries positions and context. Run `bun run check:collector-scan` for schema agreement and `bun run check:collector-history` for compatibility. |

#### LC-03 · Resume at a complete record

```gherkin
@lc03
Feature: Resume a growing file
  Scenario: The writer stops inside a UTF-8 character
    Given one line is complete and the next ends between the two bytes of "é" in "café"
    When I scan once, finish the second line and scan with a fresh collector
    Then the first scan stores only the first message
    And the second scan stores "café" once and acknowledges its ending newline
    And both checkpoints record the accepted line and session version
```

**Needs** LC-01. **First failure** The scanner advances past incomplete bytes or loses the second message.

1. **Interface.** Read across both a batch boundary and a multibyte character. Return completed lines and the next unread byte. Read a large valid record in chunks and allow it to occupy a batch by itself.
2. **Interface.** Update the storage contract and fixture. If two writers use the same version, only the first write succeeds. A new source in an existing session must see that session's current version.
3. **Integration.** Restart against the same fixture. Restore the parser state and byte offset saved with the first batch.

| LC-03 constraint | Decision and check |
| --- | --- |
| Behavior | A fresh scanner resumes both providers after the last accepted newline. A split UTF-8 character waits for its full line. Read bounded batches by bytes and give an oversized record a batch of its own. Run the [growing-file scenario](../../apps/collector/test/acceptance/scan/resume-growing-file.feature) with `bun run check:collector-scan` and the reader and restart tests with `bun run test`. |
| Observability | Each acknowledged source has a next byte, a physical line number and versioned parser state. Reading a checkpoint returns the session version even for a new source. The [concurrent-writer scenario](../../apps/collector/test/acceptance/storage/storage.feature) checks that a rejected batch leaves both records and progress intact. Run `bun run check:collector-storage` and `bun run test`. |
| Architecture | The history readers own discovery and bounded local file reads. Provider decoders carry forward the context, occurrence counts and mirror evidence needed by the next batch. The scanner coordinates the readers and the [storage port](../../apps/collector/src/storage/collector-storage.ts). The [dependency rules](../../.dependency-cruiser.collector.json) keep file access in history and storage behind the port. Run `bun run check:collector-deps`. |
| Interface | The [scan contract](local-collector/scan.tsp) adds sources, absolute byte and line positions, and batches. The [storage contract](local-collector/storage.tsp) requires the expected session version and source offset on each commit. A successful append advances both atomically. The [configuration](local-collector/config.tsp) can name an installation that shares storage with others. Omitted IDs preserve existing source keys. A scanner can rebuild the earlier empty parser state from the accepted prefix. Run `bun run check:collector-history`, `bun run check:collector-scan` and `bun run check:collector-storage`. |

An internal batch boundary must preserve the text blocks, native IDs and positions that LC-01 would import from the same complete Codex file. A lookup over the unread portion can match copies that cross a batch boundary. Keep only their identifying details and block positions. A copy appended after a scan keeps its earlier accepted message. Check both cases in `bun run test`.

Codex discovery reads through the first valid session header. A Claude file can contain several session IDs. Discovery reads its records to identify the sessions and their first working directories. An ID-only selection can stop once it finds all requested IDs in that file. Each selected session then imports from its own saved byte.

#### LC-04 · Reconcile Codex token counts

```gherkin
@lc04
Feature: Account for each measured Codex token once
  Scenario: A cumulative update covers more than the last call
    Given the last cumulative total was 120 and a later identified call of 20 was already counted
    When the total reaches 200 and the last call reports 30
    Then the session total is 200
    And the new measurements are the last call of 30 and an interval of 30

  Scenario: A second copy gives more detail about the same 200 tokens
    Given one installation recorded a verified interval of 200 tokens
    When another copy splits it into 120 and 80 and I scan both copies again
    Then the session still shows 200 tokens and the two parts account for the whole interval
```

**Needs** LC-03. **First failure** Counting just the last call gives 170. Adding the full change again gives 220.

1. **Unit.** Test repeated totals, cumulative-only counts, and a separate last-call report followed by a cumulative report. Use the rules in [Codex](#codex). Check inclusive input, cache and reasoning fields, an explicit zero, and empty usage.
2. **Integration.** Restart between the 20-token call and the next snapshot. Preserve the baseline and the calls already counted. Leave the interval's turn and model unset if they are unknown.
3. **Integration.** Import the coarse and detailed copies in both orders. Replace an interval and add its parts together. A failed replacement keeps the original total.

| LC-04 constraint | Decision and check |
| --- | --- |
| Behavior | Import measured Codex input and output once across appends, restarts and copies. Keep an identified last call and attribute the remaining change to an interval. Refine a coarse interval only when the parts cover it. Run the [Codex usage scenarios](../../apps/collector/test/acceptance/scan/codex-token-counts.feature) with `bun run check:collector-scan` and the decoder and restart tests with `bun run test`. |
| Observability | The session view shows each call or interval, inclusive input and output, any reliable breakdowns, the measured total and coverage. A missing measurement stays unknown. Withhold an uncertain addition and flag a gap. Existing service objectives apply. Run `bun run test` and `bun run check:collector-storage`. |
| Architecture | The Codex decoder derives measurements from transcript records. The scanner submits them and its checkpoint through the [storage port](../../apps/collector/src/storage/collector-storage.ts). Storage reconciles verified counter ranges inside the session transaction. The existing [dependency rules](../../.dependency-cruiser.collector.json) keep the decoder and scanner independent of the storage adapter. Run `bun run check:collector-deps`. |
| Interface | The [storage contract](local-collector/storage.tsp) adds call and interval kinds, optional call attribution and cumulative windows whose parts must conserve input and output. Older untyped observations remain readable. Competing writers use the existing version check. The [scan contract](local-collector/scan.tsp) records Codex counter state in a version 2 checkpoint. A conditional upgrade at the accepted byte can backfill a text-only checkpoint. Run `bun run check:collector-storage`, `bun run check:collector-scan` and `bun run test`. |

Copies can share a counter history when they start with the same native session header and recorded creation time. A fragment or an inherited header starts from its first reliable snapshot. A counter reset starts a separate range. When origins or overlapping counter ranges cannot be matched, keep the established measurements and report partial coverage. Store the last reliable baseline and the separately observed calls since that baseline with the checkpoint.

A separate call report carries its source's last known counter when available. If another copy already covers that range, storage retains the call pending a closing snapshot. The published total and the coarse interval stay intact until the finer parts account for the same input and output. Exercise this intermediate state in the copy integration tests.

#### LC-05 · Apply Claude usage corrections

```gherkin
@lc05
Feature: Keep one measurement per Claude request
  Scenario: A tool-only row updates an earlier text response
    Given a request uses 10 ordinary, 25 cache-read and 5 cache-write input tokens
    And its text row reports 2 output tokens and its later tool row reports 91
    When I scan both rows and replay the earlier report
    Then the session has one request with 40 input tokens and 91 output tokens
    And the session total is 131
```

**Needs** LC-02, LC-03. **First failure** The request stays at 42 or contributes both reports.

1. **Unit.** Test the two reports in both arrival orders, an explicit final correction downward, and conflicting provisional counts. Select an entire report. Check the cache-duration breakdown and an advisor iteration without adding executor iterations twice.
2. **Integration.** Separate the reports with a restart. Have two collectors propose different updates from the same stored version. Reload the winner on conflict and apply the comparison again.

| LC-05 constraint | Decision and check |
| --- | --- |
| Behavior | Scan assistant usage even when a row contains only a tool call. Preserve one measurement per request and one per advisor iteration. A final report can reduce a count. Run the [Claude correction scenario](../../apps/collector/test/acceptance/scan/claude-usage.feature) and the [cross-provider restart scenario](../../apps/collector/test/acceptance/scan/two-chats.feature) in `bun run check:collector-scan`. |
| Observability | The session shows accepted measurements, their status and revisions, and the measured total. Keep an unresolved call out of the total, flag a gap, and preserve independent calls. A diagnostic identifies the source, line and unsupported or invalid usage evidence. Existing service objectives apply. Check the returned view in `bun run test` and `bun run check:collector-storage`. |
| Architecture | The Claude parser reads native reports. The scanner sends them through the storage port. Storage compares them with accepted session evidence inside the version-checked transaction. A competing Claude correction reloads the winning checkpoint and compares again. The [dependency rules](../../.dependency-cruiser.collector.json) enforce these boundaries in `bun run check:collector-deps`. |
| Interface | The [storage contract](local-collector/storage.tsp) adds whole Claude observations, optional native IDs, completion status, cache-write durations and source diagnostics. Older usage remains readable. The [scan contract](local-collector/scan.tsp) marks Claude usage as imported in version 2. A text-only checkpoint can backfill its accepted prefix. Check both schemas and rollback with `bun run check:collector-storage`, `bun run check:collector-scan` and `bun run test`. |

Match both native identifiers when supplied. A single identifier can match only one known request. A correction keeps the first accepted ID, time and position. Compare all comparable counts together. A replay of a weaker or disputed observation cannot restore a withdrawn count. A later final or unambiguously stronger report can resolve the call. Keep recorded gaps as specified in the coverage rules.

Use the provider's advisor iteration ID when present. Otherwise use the iteration's position in the request's ordered iteration list. If an unfamiliar iteration type appears, retain the measured calls and report its source line. On a competing correction, retry from the winning checkpoint. A second conflict at the same saved position returns the affected byte range for a later scan.

#### LC-06 · Recover after a move or rewrite

```gherkin
@lc06
Feature: Recover a changed transcript
  Scenario: A rewritten file reaches the same byte offset
    Given a writer holds the old checkpoint at byte 420 for a 120-token call
    And a replacement file contains that identified call and a new 30-token call
    When a fresh collector accepts the new file through byte 420 and the old writer submits its batch
    Then the old writer receives a conflict and the session still has two calls totaling 150
```

**Needs** LC-03, LC-04. **First failure** Storage accepts the old writer's batch because the offsets match.

1. **Interface.** Move a rollout into the archive. Reuse its checkpoint. Change bytes in the middle of a same-length copy with an identical tail. Verify the saved prefix before accepting it.
2. **Integration.** Exercise truncation, a reset from an older parser, and an unsupported newer state. Replay verified IDs from zero or pause as specified. Test a rewrite that removes one of two identical, unidentified records. Preserve known history and flag the ambiguous match.

| LC-06 constraint | Decision and check |
| --- | --- |
| Behavior | Verify every accepted byte before a fresh scan resumes an append or archive move. Replay a changed or shortened transcript from its start. The [rewrite scenario](../../apps/collector/test/acceptance/scan/recover-changed-transcript.feature) covers a stale write at byte 420. Run `bun run check:collector-scan` and `bun run test`. |
| Observability | The checkpoint reports the accepted byte, SHA-256 digest and session version. The session retains accepted records and records a coverage gap when identical rows cannot be matched. An unsupported parser state reports its source and byte and keeps its checkpoint. Check the saved checkpoint, session view and error in `bun run test`. Existing service objectives apply. |
| Architecture | History streams the raw prefix once for the saved positions in one physical file. The scanner decides whether to resume or rebuild. Storage accepts an explicit reset in the same transaction as the new records and checkpoint. The [collector dependency rules](../../.dependency-cruiser.collector.json) cover these boundaries. Run `bun run check:collector-deps`. |
| Interface | The [scan contract](local-collector/scan.tsp) supplies raw prefix digests and records fallback occurrence bounds for later appends. The [storage contract](local-collector/storage.tsp) accepts an optional digest for compatibility and an explicit reset that compares the previous checkpoint. Normal writes advance the source. Run `bun run check:collector-history`, `bun run check:collector-scan` and `bun run check:collector-storage`. |

If a replacement keeps only some of several identical rows without native IDs, retain the accepted rows. Record `ambiguous-transcript-replay` at the affected source line. Reserve the accepted IDs so an identical row appended after recovery receives a new ID.

When the scanner counts repeated rows ahead of a replay batch, save the last byte and digest used for that decision until the scanner has accepted that byte. A restart verifies both positions in one pass. A change in the pending bytes requires a fresh replay.

Use parser state version 3 when resuming requires these matching decisions. Earlier parsers pause on that version. Ordinary checkpoints continue to use the version 2 decoder.

A Codex call in a replacement can overlap a cumulative interval accepted from the earlier file. Compare the two histories as separate copies. Keep the accepted interval until the replacement establishes where the call belongs.

Discovery needs a complete record that identifies the session. If truncation removes that record, keep the accepted history and checkpoint. Verify the file again when a complete identifying record returns.

#### LC-07 · Keep reading after a bad usage record

```gherkin
@lc07
Feature: Preserve known data across a gap
  Scenario: Good records follow a damaged line
    Given a session has a known 70-token call followed by a malformed complete line
    When I read the next message "Continue" and a distinct 20-token call
    Then "Continue" is present and the partial total is 90
    And the report identifies the damaged byte range
```

**Needs** LC-03, LC-04. **First failure** The later records disappear or the session shows full reported coverage.

1. **Unit.** Test a counter reset, unsupported usage, an unfinished line and known bookkeeping. Flag only a possible loss of usage. Resume from the next reliable baseline.
2. **Integration.** Commit the gap with the known records. Check `unknown` before any measurement, `partial` afterward, and a diagnostic with no message text.

| LC-07 constraint | Decision and check |
| --- | --- |
| Behavior | A damaged complete line preserves earlier measurements and later messages and calls. The [damaged-line scenario](../../apps/collector/test/acceptance/scan/preserve-known-usage.feature) checks 70 plus 20 tokens with partial coverage. Blank lines, unfinished writes and known bookkeeping add no gap. Run `bun run check:collector-scan` and `bun run test`. |
| Observability | The session reports a code, logical source, line number and exact half-open byte range. A session with no measurements reports unknown coverage and a null total. Record the diagnostic and known usage with the checkpoint. Replaying the same range reports it once. Check returned data and rollback in `bun run test` and `bun run check:collector-storage`. Existing service objectives apply. |
| Architecture | History identifies unreadable physical lines. Provider decoders decide whether a valid usage record gives a measurement or establishes a new baseline. The scanner passes source positions and known records to storage in the same write. The existing [dependency rules](../../.dependency-cruiser.collector.json) enforce these boundaries in `bun run check:collector-deps`. |
| Interface | The [scan contract](local-collector/scan.tsp) adds the first byte of each batch entry, damaged line ranges and a checkpoint state for a pending Codex baseline. The [storage contract](local-collector/storage.tsp) adds range-bearing diagnostics for unreadable lines, unsupported Codex usage and counter resets. Existing line-only diagnostics remain readable. Run `bun run check:collector-history`, `bun run check:collector-scan` and `bun run check:collector-storage`. |

A damaged line includes its terminating newline in the reported range. If a Claude file contains several sessions, an unreadable line may have belonged to any selected session in that file. A valid record with a session ID belongs only to that session.

After a possible break in the Codex counters, keep independently identified calls. The next reliable cumulative snapshot establishes a baseline. Count subsequent verified differences. An empty rate-limit update or a missing optional breakdown does not interrupt the counters.

JSON whitespace before a fresh Codex session header preserves its starting baseline. A preceding unreadable or unidentified record still leaves the origin uncertain.

If another copy saw a counter reset hidden in the damaged line, both may later contain the same native snapshots. Match both boundary reports within the same verified session history to count the interval once. If the second copy has reached only part of the interval, keep the accepted measurement and any independent calls outside it. Equal token counts alone cannot establish a match.

#### LC-08 · Retry a write after a lost connection

```gherkin
@lc08
Feature: Sync after a lost connection
  Scenario Outline: The collector loses its connection during a 30-token upload
    Given storage holds a 120-token call and the source contains one more call of 30
    When the connection drops <moment> and I scan again after reconnecting
    Then I can read two calls totaling 150 and the checkpoint is at the end of the new call

    Examples:
      | moment                |
      | before storage writes |
      | after storage writes  |
```

**Needs** LC-03, LC-04. **First failure** A retained call is lost or counted twice.

1. **Unit.** Simulate a timeout and a version conflict. Discard unconfirmed parser state and read the stored checkpoint. Use a test clock for retry delays.
2. **Integration.** Drop the request, then drop only the reply. Reuse both cases for the HTTP client in LC-15.

| LC-08 constraint | Decision and check |
| --- | --- |
| Behavior | Run the [lost connection scenario](../../apps/collector/test/acceptance/scan/retry-lost-connection.feature) through `scan --once`. Drop the request and the reply separately. A fresh scan against the same storage must return both calls once, 150 tokens and the accepted end byte. Run `bun run check:collector-scan` and `bun run test`. |
| Observability | An unresolved write reports pending work, its logical source, the attempted byte range and the suggested retry time. Check the report against its schema and use a test clock to check the delay. Confirm that a transport failure preserves the session's measured coverage. Existing service objectives apply. |
| Architecture | The scanner reconciles through the existing storage port. The adapter identifies transport failures. The transcript and the accepted checkpoint supply the retry data. The [collector dependency rules](../../.dependency-cruiser.collector.json) apply. Run `bun run check:collector-deps`. |
| Interface | The [scan contract](local-collector/scan.tsp) defines the pending report. Successful scans still return selected sessions. The [storage contract](local-collector/storage.tsp) retains its three commit outcomes and documents that a lost reply leaves the outcome unknown. Run `bun run check:collector-scan` and `bun run check:collector-storage`. |

After a write times out or loses its connection, read the stored checkpoint and session version. If storage confirms progress, verify the winning bytes and resume from its parser state. If the read fails or the write is still unconfirmed, end the one-time scan with a pending report. The CLI writes that JSON report to standard error and exits with status 75 (temporary failure). A fresh scan can retry immediately after reconnection. Suggest a one-second delay to automatic callers.

On a version conflict, rebuild the affected batch from the winning checkpoint. Stop a repeated conflict at the same saved position and report it for a later scan. If another writer accepted a different file, preserve its checkpoint for a fresh capture.

#### LC-09 · Isolate a rejected batch

```gherkin
@lc09
Feature: Continue scanning other sources
  Scenario: One stream reuses a message ID for different text
    Given source A changes the stored text "Original" under the same ID and source B has a 12-token call
    When I scan both sources
    Then A keeps "Original" and its previous checkpoint
    And B shows 12 tokens and the scan identifies A's rejected range
```

**Needs** LC-03, LC-08. **First failure** A rejected batch advances A or blocks B.

1. **Unit.** Return `invalid` for A. Stop that file for this scan and report its byte range. Avoid an immediate retry of the same batch.
2. **Integration.** Use the fixture's real rejection. Verify that accepted messages, usage and metadata in A survive and that B commits.

#### LC-10 · Count a Codex fork's own work

```gherkin
@lc10
Feature: Separate parent and child usage
  Scenario: The parent continues after the fork
    Given a Codex parent had 200 tokens at the fork and now has 260
    And the child copied the prefix of 200 and its next cumulative total is 225
    When I discover the child before the archived parent and scan twice
    Then the parent shows 260 and the linked child shows 25
```

**Needs** LC-04, LC-06, LC-07. **First failure** The child gets the copied 200 tokens or loses its own 25.

1. **Unit.** Compare the fork prefix. Test both an inherited counter and a verified fresh child counter. A missing or cyclic parent link cannot establish ownership.
2. **Integration.** Read the child first, then the parent. Repeat with the parent initially unavailable. Keep child text and independently identified calls. Revisit the uncertain range when the parent becomes available.

#### LC-11 · Count Claude fork and subagent calls once

```gherkin
@lc11
Feature: Keep one owner for each Claude call
  Scenario Outline: A child inherits a 100-token parent call
    Given a Claude parent used 100 tokens and its <child> copies that call
    And the child makes a separate 25-token call
    When I collect both transcripts in either order
    Then the parent shows 100 and the linked child shows 25

    Examples:
      | child                           |
      | fork with new transcript UUIDs  |
      | subagent with the parent ID     |
```

**Needs** LC-02, LC-05, LC-07. **First failure** Both sessions claim the inherited call, or the child disappears into its parent.

1. **Unit.** Use two native agent IDs under the same parent. Check a copied model message with a changed request ID and two genuinely separate requests. Only a verified parent match establishes a replay.
2. **Integration.** Collect the copies from two installations. Enforce one owner for a confirmed provider call in the workspace. Test late evidence of its origin and a copy whose origin cannot be proven.

#### LC-12 · Report a missing source

```gherkin
@lc12
Feature: Explain what was lost when a file disappears
  Scenario Outline: A fresh collector confirms that a known source is missing
    Given this installation acknowledged 70 tokens through byte 420 and saw complete data through <end>
    When a fresh collector successfully scans all possible locations twice and the file is absent
    Then it reports one missing source at 420 and the total stays 70 with <coverage> coverage

    Examples:
      | end | coverage |
      | 420 | reported |
      | 500 | partial  |
```

**Needs** LC-06, LC-07, LC-08. **First failure** A fresh collector cannot name the missing file, or a normal file removal makes a known total partial.

1. **Interface.** List acknowledged sources for just this installation and selection. Record a change of presence at the same offset. Reject a stale version.
2. **Integration.** Test an archive move, an unreadable root, a change in workspace selection, a returning file and a second installation. None of these alone proves data loss.

#### LC-13 · Run the scanner on a schedule

```gherkin
@lc13
Feature: Pick up a chat created after startup
  Scenario: A planning chat appears between scans
    Given the startup scan finished and a new planning chat appears before the next interval
    When the next interval elapses
    Then the chat is readable and the scan reports one new session
```

**Needs** LC-03, LC-08, LC-09. **First failure** The chat stays unread until someone runs another command.

1. **Unit.** Use a test clock for startup, a slow scan and shutdown. Allow one active scan per collector. Track pending age until storage accepts the work.
2. **Integration.** Use the regular scan handler for both commands. At this milestone run LC-01 through LC-13 and `@two_chats` against temporary files and the fixture.

### Remote service and durable storage

#### LC-14 · Bind the API to a workspace

```gherkin
@lc14
Feature: Keep workspace data separate
  Scenario: Two credentials request the same session ID
    Given workspace A has a 130-token session and workspace B is empty
    When each workspace requests that session through the API
    Then A reads 130 and B sees no session

  Scenario: A credential has expired
    Given a new session has no stored checkpoint
    When a collector submits it with an expired credential
    Then the API returns an authentication error and stores nothing
```

**Needs** LC-11, LC-12 and the storage contract. **First failure** The API cannot return the right result for each credential.

1. **Interface.** Define versioned HTTP operations, authentication and responses in TypeSpec. Test missing credentials, malformed JSON and typed storage outcomes. Derive workspace and installation from the verified credential.
2. **Integration.** Run the same storage cases through a local API and test credentials. A workspace in the request body cannot give access to another workspace's session or inventory.

#### LC-15 · Sync through the HTTP client

```gherkin
@lc15
Feature: Resume a remote upload
  Scenario: The server accepts a call but the reply is lost
    Given the API holds a 120-token call and accepts another 30 before the connection drops
    When I restart the collector and sync to the same API
    Then an authenticated read returns two calls totaling 150 and the checkpoint covers both
```

**Needs** LC-08, LC-09, LC-14. **First failure** A restarted client cannot recover the accepted checkpoint over HTTP.

1. **Interface.** Exercise the client with a local test transport. Map timeouts and rate limits to delayed retries. Surface invalid credentials to the caller and invalid batches to the affected source.
2. **Integration.** Run the LC-08 lost-reply case across a real loopback connection. Restart only the scanner. Read the result through the API.

#### LC-16 · Keep accepted data across API restarts

```gherkin
@lc16
Feature: Read stored data after a server restart
  Scenario: Two workspaces share a native session ID
    Given A stored that ID with 120 tokens at byte 420 and B stored it with 9 tokens at byte 70
    When the API restarts with a new connection to the same database
    Then A still reads 120 at byte 420 and B reads 9 at byte 70
```

**Needs** LC-14 and a database choice. **First failure** A new server loses or mixes the two sessions.

1. **Interface.** Write the restart and LC-17 race scenarios before building the adapter. Run server-owned migrations in a disposable database. Use workspace-scoped keys for sessions and records. Scope source checkpoints by installation as well.
2. **Integration.** After restart, compare the text, order, latest correction, coverage, ownership and source status to the fixture. Use one storage contract suite for both adapters.

#### LC-17 · Make competing writes atomic

```gherkin
@lc17
Feature: Apply a whole batch once
  Scenario: Two workers attempt the first write to one source
    Given two workers read version zero and prepare different first batches for the same source
    When they submit their batches on independent database connections
    Then exactly one receives "committed" and one receives "conflict"
    And a new reader sees only the winner's records and checkpoint
```

**Needs** LC-16. **First failure** Two workers win, or part of a failed batch becomes visible.

1. **Interface.** Enforce the session version check and all updates in one transaction, including the first insert. Repeat with two different sources in one session. After the loser reloads, both distinct calls must survive.
2. **Integration.** Force a failure after writing a record. Check rollback of text, usage, ownership, source state and version. Retry once from the old checkpoint. Run the fixture contract and `@two_chats` through the real client, API and database before release.
