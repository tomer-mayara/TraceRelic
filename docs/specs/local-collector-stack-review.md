# Local collector stack review and repair plan

The review covers the 19 draft PRs from LC-00b through LC-17 at commit `862402c`. LC-00a is the merged
history-reader prerequisite. The collector must return the right chat and token total after appends,
rewrites, outages, forks and API restarts. [Current specification](local-collector.md) ·
[Last PR in the reviewed stack](https://github.com/tomer-mayara/TraceRelic/pull/22)

## Constraints for the review and repairs

| Constraint | Decision and check |
| --- | --- |
| Behavior | Put each repair's failing example in the existing history, scan, API or PostgreSQL suite. Exercise the public reader or command and check accepted state after a second scan or restart. The [collector](../../apps/collector/component.yaml) and [API](../../apps/api/component.yaml) manifests list the executable scenarios. |
| Observability | Keep scan outcomes, byte ranges, pending age and API commit outcomes. Use those signals to verify absence, backoff and rejection. Measure wire bytes, replayed writes and projection rows for the capacity work. Set a service target once production measurements exist. |
| Architecture | Keep one scan core, provider-specific decoding, one storage port and API-owned PostgreSQL. Verify the existing boundary with `bun run check:collector-deps`. Share a mechanism only when its ownership, evidence and retry rules match. |
| Interface | Keep the public date reader, one-time session views, storage compare-and-swap and version 1 HTTP operations compatible. Specify additions for exact time bounds, versioned checkpoint reconstruction, verified source continuity and evidence corrections in [history](local-collector/history.tsp), [scan](local-collector/scan.tsp), [storage](local-collector/storage.tsp) and the [API](collector-api/main.tsp). Exercise earlier persisted data, generated schemas and both adapters. |

## Repair delivery

The repairs form one integration change above LC-17. The 19 original PRs retain their review history.
The table links the public behaviors and regression checks for the combined stack.

| Area | Implemented result |
| --- | --- |
| Source identity and capture | Selection and reads share a verified file extent. Plain and compressed rollouts use the same logical byte positions. Session and project selectors use the recorded path syntax, and a changing file can be retried while healthy files progress. [History tests](../../apps/collector/test/interface/history) · [Recovery scenarios](../../apps/collector/test/acceptance/scan/recover-changed-transcript.feature) |
| Presence and watch | Missing sources retain the strongest verified suffix. Recovery checks the original bytes, including a matching anonymous Claude continuation. Watch skips final session downloads and respects retry deadlines and terminal credential errors. [Presence scenarios](../../apps/collector/test/acceptance/scan/missing-source.feature) · [Loopback watch tests](../../apps/api/test/integration/collector/watch-protocol.test.ts) |
| Chat and accounting | Paginated Codex items, block mirrors, native response usage, call aliases and Claude advisor positions use provider evidence. Forks keep child chat and charge verified calls to the owner. [Chat and evidence tests](../../apps/collector/test/integration/scan/message-evidence.test.ts) · [Accounting and fork parity](../../apps/api/test/integration/collector/accounting-repair.test.ts) |
| Previously accepted data | A verified prefix repairs only the relevant generation. A native-header and two-session version check can retract corroborated text from the wrong Codex session. Earlier records with insufficient proof remain visible with `unverified-source-history`. Startup also corrects coverage for old missing or replaced generations. [Versioned data repair](../../apps/api/test/integration/collector/legacy-history-migration.test.ts) · [Wrong-session rollback and restart](../../apps/api/test/integration/postgres/codex-identity-repair.test.ts) |
| Remote sync | The API accepts versioned, digest-checked transfers under the existing credential. It can resume large histories and resolve proved aliases across both installation settings. [Long call sequence](../../apps/api/test/acceptance/collector/remote-sync.feature) · [17,000 anonymous messages and restart](../../apps/api/test/integration/collector/long-anonymous-history.test.ts) |
| PostgreSQL and CI | PostgreSQL projects changed records and their positions. Ordinary presence requires zero record updates. CI builds the workspace and shared schemas once and reports the individual contract and behavior checks. [Competing writes and projection](../../apps/api/test/acceptance/postgres/competing-writes.feature) · [CI workflow](../../.github/workflows/collector.yml) |

Three upgrade cases use the same public contracts and checks. Preserve uncertainty for a known
scanner file whose legacy checkpoint has an empty decoder and a positive offset. Require a physical
line number before retracting text across sessions. Keep the original precedence of Claude current
and backup metadata during correction. Exercise both behaviors through a scanner restart. Replay an
LC-17 PostgreSQL journal with its original session revisions so a corrected peer ownership decision
cannot block later writes. Check the stored views, both session versions and an unrelated write
after reopening the database. The scanner and PostgreSQL contract suites cover these cases.

## Review snapshot

At the original review, all 19 PRs were drafts with passing head checks. They formed an unbroken chain
above LC-00a, which was already in `main` at `3a35b6e`. GitHub had no submitted review on those 19 PRs.
The findings below refer to the combined code at `862402c`. The source links point to that revision.

## Findings and acceptance checks

Start with source identity and capture. Decoding, ownership and historical repair all depend on knowing
which bytes belong to which session. A P1 can file data in the wrong workspace or chat, silently lose
evidence, report a wrong total, or prevent further sync of an ordinary transcript. Put a failing
public-entry-point case in the named existing suite before changing each behavior.

### 1. Bind selection and writes to the same source

- **P1 · Wrong chat after an in-place rewrite.** An A-only scan discovered a 1,248-byte file. During the
  checkpoint read it was rewritten in place as a 2,256-byte session B. Storage accepted B's visible text
  under A. Growth on the same inode bypasses the change check. Bind the selected header and fixed read
  extent to verified bytes. If the file changes during a read, discard the provisional batch, reload the
  checkpoint and reselect. Preserve the original extent for a real append. A digest of the selected
  extent can do this in bounded memory. Exercise changes during discovery, after the first committed
  batch and across a split UTF-8 suffix.
  [Capture check](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/history/captured-transcript-file.ts#L141) ·
  [Selection and read](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/history/local-llm-history-codex.ts#L79)
- **P1 · Project selection imports unrelated chats.** On macOS, selecting the collector's current
  directory imported a Codex file with a Windows working directory and another with a relative working
  directory. Inventory for that selection contained only the actual local match. Validate the recorded
  path before matching and use the same containment rule in discovery and inventory. A foreign or
  relative path needs an explicit mapping or session selection to establish membership. Check
  `--project`, `--session`, sibling directories, drive letters and UNC roots.
  **P2 · Remote counterpart.** A valid Windows source observation received 422 from the POSIX API, where
  an equivalent POSIX source received 200. Interpret the source installation's path syntax for
  validation and comparisons.
  [Local selection](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/history/local-llm-history.ts#L115) ·
  [Inventory matching](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/storage/collector-storage.ts#L75) ·
  [API storage validation](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/storage/source-inventory.ts#L36)
- **P2 · An archive rename aborts unrelated files.** Moving a rollout to the archive before its first
  batch threw `TranscriptChangedError`. A second, healthy session was absent until the next invocation.
  Rediscover the affected file with a bounded retry, continue independent files, and surface any
  outstanding source. Test a rename and a continuously changing file beside a healthy one.
  [Per-file loop](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/scan/local-collector.ts#L120) ·
  [Rewrite suite](../../apps/collector/test/acceptance/scan/recover-changed-transcript.feature)

### 2. Preserve evidence across disappearance and rotation

- **P1 · A second outage hides a known gap.** Storage accepted 70 tokens through byte 256. The scanner
  verified the prefix and parsed complete records through 451. The upload dropped before commit and
  the next pass failed to read the checkpoint. After
  removal and reconnect it reported 256/256 and `reported`. The correct result is 256/451 and `partial`.
  Retain the greatest proved end with evidence of its contents, version and generation. Invalidate
  the proof on an incompatible rewrite. Repeat with an uncommitted upload, a committed upload with a lost reply,
  and recovery of the suffix.
  [Sighting replacement](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/scan/source-sightings.ts#L56)
- **P1 · Claude backup handling can lose text or conceal a missing source.** After a valid 130-byte
  prefix, an anonymous user message brought a file to 262 bytes. Renaming it directly to its superseded
  filename consumed the copy without importing the message. Separately, a backup with different prefix
  bytes kept a missing current file marked present at 338 of 418 bytes. Use one decision for both cases.
  A matching session and accepted prefix establish continuity through the accepted byte. Import the
  verified continuation, including a UUID-less suffix. Clear a previously observed gap only when the
  recovered suffix matches its evidence. A mismatching backup remains independent. An unreadable one
  leaves recovery undetermined. Test before and after a missing report, including equal-length
  backups with different suffixes. [Copy recovery](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/scan/source-presence.ts#L96) ·
  [Candidate enumeration](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/history/local-llm-history-claude.ts#L129) ·
  [Presence suite](../../apps/collector/test/acceptance/scan/missing-source.feature)

### 3. Read provider evidence before inferring chat or usage

- **P1 · Native Codex rows are skipped.** In a paginated rollout, raw model input was displayed while
  the distinct completed user item and canonical-only assistant reply were omitted. A native
  `token_usage_record` for 95 input and 25 output tokens produced zero calls and an `unknown` total.
  Prefer completed visible items and per-response usage when available. Use legacy mirror and counter
  inference for older files. Test native-only, legacy-only and mixed representations across a batch,
  restart and fork. The same response must count once. The producer already records the thread, turn and
  response IDs. [Chat decoder](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/scan/codex-chat.ts#L298) ·
  [Usage decoder](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/scan/codex-usage.ts#L171) ·
  [Provider text fixture](https://github.com/openai/codex/blob/ea8ccc1d20ff65398e02490ac34f8c1012848625/codex-rs/app-server/tests/suite/v2/thread_fork.rs#L1955-L1988)
  ·
  [Provider token fixture](https://github.com/openai/codex/blob/ea8ccc1d20ff65398e02490ac34f8c1012848625/codex-rs/core/tests/suite/token_usage_rollout.rs#L89-L115)
- **P2 · Mirror and fallback IDs depend on arrival history.** A two-block Codex answer also displayed
  its joined legacy mirror. In two installations, one reading a complete file and one receiving a native
  mirror later, the same prompt appeared twice. Two byte-identical Claude copies without a row UUID also
  displayed the same block twice because the fallback includes its absolute filename. Match native
  item/block identities and verified shared occurrences. Preserve two real identical prompts and
  independent sources. Use both installation orders, two scan boundaries and restart.
  [Codex refinements](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/scan/codex-chat.ts#L111) ·
  [Claude fallback](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/scan/claude-chat.ts#L62) ·
  [Provider mirror forms](https://github.com/openai/codex/blob/ea8ccc1d20ff65398e02490ac34f8c1012848625/codex-rs/protocol/src/legacy_events.rs#L128-L154)
- **P2 · Damaged records leave stale chat context.** An unlabelled message after a malformed record
  inherited the preceding turn and request IDs. Pass the position of the gap to both decoders, clear
  unverified attribution and pending mirror matches there, and resume attribution at fresh evidence.
  Assert both sides of the gap and keep later independently identified calls.
  [Chat and usage dispatch](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/scan/codex-session-parser.ts#L52) ·
  [Damage suite](../../apps/collector/test/acceptance/scan/preserve-known-usage.feature)
- **P2 · Fractional history bounds collapse in the CLI.** A record at `.0003Z` was absent from
  `[.0002Z, .0007Z)`. Reversing those bounds also returned success with an empty result. Both strings
  are converted to millisecond `Date` values before validation of the range. Compare accepted CLI
  instants at their supplied precision. Preserve the public reader's `Date` signature. Test both
  providers, adjacent windows, offsets and reversed bounds.
  [CLI conversion](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/commands/collector-command.ts#L30) ·
  [History windows](../../apps/collector/test/interface/history/history-windows.feature)

Two format decisions extend the original plain-JSONL and visible-text examples. Codex can compress an
old rollout to `.jsonl.zst`. A losslessly compressed fixture disappeared from date history and
triggered a missing report. Recognize it as a possible source during absence checks. For full support,
verify and checkpoint the logical uncompressed bytes across compression, restart and simultaneous
plain/compressed copies. Claude generated `<tick>` and `<goal>` rows were displayed as user text. Define
which provider-marked envelopes to omit, and retain an ordinary user message that quotes the same
strings. The SDK's first-prompt filter is evidence of their provenance.
[Codex discovery](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/history/local-llm-history-codex.ts#L68) ·
[Provider compression](https://github.com/openai/codex/blob/ea8ccc1d20ff65398e02490ac34f8c1012848625/codex-rs/rollout/src/compression.rs#L63-L70)
· [Claude decoder](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/scan/claude-chat.ts#L88) ·
[SDK first-prompt filter](https://github.com/anthropics/claude-agent-sdk-python/blob/69846cdf82aef59add3b14a26b4f16d1ccee26ba/src/claude_agent_sdk/_internal/sessions.py#L50-L60)

### 4. Keep one measurement when evidence improves

| Priority and case | Observed at the reviewed tip | Smallest correction and regression |
| --- | --- | --- |
| P1 · Codex call gains a request ID | One report identified a 10-token call as `call_id=A`. A second retained `call_id=A` and added `request_id=R`. Together they produced 20 and `reported` in either order. A closing cumulative total of 10 did not repair it. | Keep both native identifiers as evidence for the first accepted measurement. Check late, missing and disagreeing IDs, two distinct calls sharing a request, copies and old checkpoints. [Native key](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/scan/codex-usage-report.ts#L97) |
| P1 · Codex fork sees a shorter parent | Child 25 became 125 and `reported` when its parent was truncated to its genuine first 80-token snapshot. Adding the shorter copy alongside the full parent instead reduced the child to 5 and `partial`. | Compare ordered evidence on the shared prefix. Preserve the strongest verified fork boundary when all available evidence agrees. Actual contradictions can revoke proof. Test both cases, a contradiction and a repeat with stable versions. [Fork decision](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/scan/codex-fork-sources.ts#L52) · [Copy comparison](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/scan/codex-fork-evidence.ts#L258) |
| P1 · Claude advisor gains an ID | An executor of 10 and an advisor of 6 produced 22 when a copy supplied a native ID at the same ordered iteration position. Correct total is 16 in either arrival order. | Keep position and native ID together within the verified request. Test both orders, two genuinely distinct advisors and a restart between reports. [Advisor identity](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/scan/claude-usage.ts#L108) |
| P2 · A verified Claude fork supplies a new advisor | A copied final corrected the parent's 100-token executor to 80. Its new 30-token advisor was withheld. Parent showed 80 instead of 110 and the child's own 25 remained measured. | Resolve the request owner once, then apply its executor and distinct advisor measurements. Test parent-first, child-first, a later parent-only scan and ambiguous siblings. [Origin matching](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/storage/claude-origin-reports.ts#L122) |

**Existing data.** Changing key precedence only affects future observations. Old Codex checkpoints can
retain just one hashed identifier. Old native advisor entries can lack their position. Claude's
fallback text ID hashes the machine path. Recover its inputs from the recorded source location and
verified transcript bytes. Build a fixture containing already persisted old checkpoints, messages,
windows and duplicate usage rows. Replay a verified source or journal evidence, retain established IDs
where possible, repair affected owners and totals atomically, and prove the second repair does nothing.
If the original bytes or an unambiguous mapping are unavailable, preserve the evidence and expose the
uncertainty. Apply the same rule before moving any previously misfiled messages between sessions.
[Checkpoint model](local-collector/storage.tsp) ·
[Storage scenarios](../../apps/collector/test/acceptance/storage/storage.feature)

### 5. Make ordinary remote scans finish

- **P1 · Legal small records eventually cannot upload.** The loopback API accepted 2,579 small Codex
  calls. The next single 176-byte line generated a 1,048,919-byte request, exceeded the API's 1 MiB
  limit and returned HTTP 413. The
  serialized parser state alone was 975,486 bytes. A fresh file of 1,100 such rows failed in its first
  batch. A separate 17,000-message fixture also stalled at the same byte on consecutive scans. Bound
  request size using encoded wire bytes and give growing identity/occurrence evidence a versioned
  incremental or reconstructible representation. Shrinking the source batch alone cannot make a single
  oversized checkpoint fit. Verify fresh and restarted long sources, repeated prompts, fork corrections
  and rejection of a genuinely indivisible oversized record with another healthy file.
  [Checkpoint serialization](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/scan/transcript-cursor.ts#L208) ·
  [HTTP outcome](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/storage/http-collector-storage.ts#L107) ·
  [Remote sync suite](../../apps/api/test/acceptance/collector/remote-sync.feature)
- **P2 · Equivalent authenticated configuration creates two checkpoints.** Scanning a 254-byte file,
  then supplying the credential's own installation ID, saved a second inventory row. Deleting the file
  emitted two missing reports. Resolve scanner-generated aliases within the authenticated installation
  using exact source location and verified checkpoint evidence. Exercise both config orders and
  pre-existing divergent rows. Preserve local root-based keys, distinct roots, separate backup streams
  and opaque API stream IDs when equivalence is unproved.
  [Stream identity](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/scan/source-sightings.ts#L51) ·
  [Configuration contract](local-collector/config.tsp)
- **P2 · Concurrent checkpoint reads discard the longer backoff.** In a manual-clock test, two reads
  for one Claude file received one-second and 60-second backoffs from the storage adapter. Watch
  retried both after one second. If reads remain
  concurrent, wait for all started reads, give authentication failure precedence and honor the latest
  deadline. Sequential reads are sufficient if the scanner stops at the first response and honors every
  deadline it actually receives. Keep one shared prefix verification per file. Test different deadlines
  and a terminal credential error with a manual clock.
  [Checkpoint reads](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/scan/local-collector.ts#L111) ·
  [Watch suite](../../apps/collector/test/acceptance/scan/scheduled-scan.feature)

### 6. Remove work that does not affect the result

- **Watch.** Each unchanged pass downloaded a 221,313-byte session view and discarded it. Let the shared
  import core return completion and progress. Request final views in `scan --once` and during recovery
  where needed. Verify zero final view downloads on two unchanged ticks, identical one-time JSON and
  accurate pending, rejected and new-session reports.
  [View reads](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/scan/local-collector.ts#L139) ·
  [Watch consumer](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/collector/src/scan/scheduled-scanner.ts#L66)
- **PostgreSQL.** On an isolated database, 128 one-message appends supplied 8,256 message rows to the
  SQL projection. One presence-only update on a cold writer replayed all 128 journal entries and
  supplied all 128 unchanged message rows again. SQL avoids updating identical payloads but still
  receives and compares them. First project only changed rows, including removals and ownership
  transfers. Measure warm and cold writes at the intended workload before adding a recovery snapshot.
  Keep the workspace lock, journal evidence, both version checks and rollback guarantees until a
  measured alternative passes the same tests.
  [Writer replay](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/api/src/storage/postgres-collector-storage.ts#L21) ·
  [SQL projection](https://github.com/tomer-mayara/TraceRelic/blob/862402c33867c33c84caa37735f4a8d52ebe6b44/apps/api/src/storage/collector-database.ts#L96)
- **CI.** The six contract commands and `bun run test` each invoke the full build. Five also invoke the
  same collector dependency check. Build and generate shared artifacts once per CI job, then run the
  same named suites with their existing failure reporting. Keep standalone check commands usable from a
  clean checkout. Prove the same scenario, compilation and schema checks run before changing the
  workflow. [Scripts](../../package.json) · [Workflow](../../.github/workflows/collector.yml)

## Disposition of every draft PR

LC-00a ([#2](https://github.com/tomer-mayara/TraceRelic/pull/2)) supplies the merged Codex history
reader and CLI used by this stack. The fractional-bound finding also applies to that entry point.

| Ticket and PR | What to keep or simplify |
| --- | --- |
| LC-00b · [#3](https://github.com/tomer-mayara/TraceRelic/pull/3) | Keep raw Claude project and subagent records behind the same history interface. Preserve the independent reader and exact provider payload. |
| LC-00c · [#4](https://github.com/tomer-mayara/TraceRelic/pull/4) | Keep one date-window contract for both providers. Extend its CLI coverage to sub-millisecond bounds. |
| LC-01 · [#6](https://github.com/tomer-mayara/TraceRelic/pull/6) | Share one project containment rule with inventory. Prefer the provider's visible item, then handle legacy mirror forms. |
| LC-02 · [#7](https://github.com/tomer-mayara/TraceRelic/pull/7) | Keep row UUID plus block position and tool-only usage. Recover anonymous rows only where the same history can be proved. |
| LC-03 · [#8](https://github.com/tomer-mayara/TraceRelic/pull/8) | Keep complete lines, UTF-8 handling and atomic progress. Tie identity to the capture and bound checkpoint growth on the wire. |
| LC-04 · [#9](https://github.com/tomer-mayara/TraceRelic/pull/9) | Prefer per-response measurements. Keep cumulative reconciliation and atomic interval refinement for legacy evidence. Preserve call aliases. |
| LC-05 · [#10](https://github.com/tomer-mayara/TraceRelic/pull/10) | Keep whole-report precedence, including lower finals. Resolve an advisor's position and native ID together. |
| LC-06 · [#11](https://github.com/tomer-mayara/TraceRelic/pull/11) | Keep full-prefix verification and compare-and-reset. Rediscover a changed source locally and preserve previously accepted evidence. |
| LC-07 · [#12](https://github.com/tomer-mayara/TraceRelic/pull/12) | Keep exact damaged-byte ranges and conservative counter baselines. Deliver the same ordered gap to chat and usage. |
| LC-08 · [#13](https://github.com/tomer-mayara/TraceRelic/pull/13) | Keep storage as the authority after a lost reply. Recovery before and after commit passed. A separate local upload queue would duplicate that authority. |
| LC-09 · [#14](https://github.com/tomer-mayara/TraceRelic/pull/14) | Stop the rejected physical file, including other sessions in it, and skip copies of the rejected stream. Earlier commits survive and independent files continue. The isolation scenario passed. |
| LC-10 · [#15](https://github.com/tomer-mayara/TraceRelic/pull/15) | Keep verified lineage and reclassification. Use recorded ownership or a verified fork boundary and retain the longest compatible proof. |
| LC-11 · [#16](https://github.com/tomer-mayara/TraceRelic/pull/16) | Resolve the owner once for a Claude request. Keep separate child identities and update both versions together on transfer. |
| LC-12 · [#17](https://github.com/tomer-mayara/TraceRelic/pull/17) | Keep scoped inventory and the distinction between a fully accepted file and a lost suffix. Use the same prefix proof for rotation, presence and recovery. |
| LC-13 · [#18](https://github.com/tomer-mayara/TraceRelic/pull/18) | Keep one timing loop and its pending-age reports. Omit final session downloads from watch and respect all received retry deadlines. |
| LC-14 · [#19](https://github.com/tomer-mayara/TraceRelic/pull/19) | Keep credential-scoped operations and workspace isolation. Validate uploaded paths using the source platform's semantics. |
| LC-15 · [#20](https://github.com/tomer-mayara/TraceRelic/pull/20) | Keep one HTTP adapter behind the storage port. Bound serialized writes and resolve unambiguous credential-scoped source aliases. |
| LC-16 · [#21](https://github.com/tomer-mayara/TraceRelic/pull/21) | Keep durable evidence and restart parity with memory. Project changed rows and measure cold recovery before introducing snapshots. |
| LC-17 · [#22](https://github.com/tomer-mayara/TraceRelic/pull/22) | Keep first-write conflict detection, workspace-wide ownership atomicity and rollback. Use the existing race, fault and retry suites for every storage change. |

## Verification and release

The original review passed 533 Node tests and 68 Cucumber scenario executions. New regression tests
cover the failures reproduced above. The repaired workspace passes 617 Node tests and 86 Cucumber
scenario executions across the six standalone checks. The shared scenarios run against each supported
adapter. The history suite also runs its six compression checks under Bun. Workspace lint, dependency
boundaries, generated contracts and Habit Hooks pass. Verification
uses synthetic transcripts and disposable PostgreSQL 18.7 databases with Node 26.13.1 and Bun 1.4.4.

A 2,800-call rollout grew its parser state to 1,053,422 bytes. The largest initial upload request was
699,170 bytes. After a scanner restart, appending one call used one 5,411-byte write. A separate
17,000-message transcript kept every ID when the scanner and API restarted and a repeated prompt was
appended. [Remote sync](../../apps/api/test/acceptance/collector/remote-sync.feature)

The 128-append projection test submitted 128 message rows after the repair, down from 8,256. A new
writer then replayed 128 journal entries to reconstruct ownership and submitted zero message rows for a
presence-only change. A local run took about 1.4 seconds for the appends and 13 milliseconds for cold
presence. These measurements describe this fixture. Production measurements can guide a recovery
snapshot or a service target. [Projection test](../../apps/api/test/acceptance/postgres/competing-writes.feature)

The release gate is human review of the combined repair and the project's required checks on the
stack. Use the one-time scanner against the existing workspace to reconcile available sources.
An unverified historical generation can keep its measured total partial. The journal retains the
evidence for investigating it. [Feature workflow](../engineering-guidelines/new-feature-planning.md) ·
[Two-chat scenario](../../apps/collector/test/acceptance/scan/two-chats.feature) ·
[Database concurrency suite](../../apps/api/test/acceptance/postgres)
