# Local collector structure cleanup

A developer opens `apps/collector/src/` and finds one class that reads history between two dates. That
class receives its providers. One directory for each provider holds all the code that knows that
provider's files and records. Each rule belongs to a class. The CLI output, the exit codes, the stored
sessions and the checkpoints stay the same. [Current specification](local-collector.md)

This document reviews the structure at commit `21ab8a9` and gives the cleanup plan. Line links refer to
that commit. No production code has changed.

Affected components: `apps/collector` (all of `src/` and the test imports) and `apps/api` (only its
imports of the storage helpers that change name).

## Status

Steps 0 and 1 are complete on 2026-11-22. Steps 2 and 3 are complete on 2026-11-23. The owner accepted
the five recommendations in [Decisions for the owner](#decisions-for-the-owner). The sections
[Baseline](#baseline) and [Findings](#findings) describe the code before step 1, at commit `21ab8a9`.
They name each file by its path at that commit. The table in
[Where the current files go](#where-the-current-files-go) gives the path of each file after step 2.
[The scanner](#the-scanner) and [step 3](#step-3-the-scanner-receives-its-providers) describe the port
as it is after step 3.

| Measure | Before | After step 1 | After step 2 | After step 3 |
| --- | ---: | ---: | ---: | ---: |
| Top-level functions in `history/` and `providers/` | 7 | 0 | 67 | 67 |
| Top-level functions in all of `src/` | 265 | 262 | 258 | 256 |
| Classes | 57 | 67 | 67 | 70 |
| Node tests | 687 | 778 | 778 | 809 |
| Collector scenarios | 47 | 49 | 49 | 52 |

Step 2 changed no function. The 67 functions came into `providers/` with the parser files, and all of
them are in the ten files of the `pending` list. Four functions left `src/` with the two shared leaf
modules. Step 3 moved two functions of `scan/` into provider classes. Its three new classes are
`CodexScan`, `ClaudeScan` and `ClaudeEarlierCopies`.

Results of step 1:

- **Output comparison.** `scan --once` and `history` give the same bytes as before step 1 on the frozen
  sample. The comparison ran five commands: a full scan, a full history window, a scan with `--session`,
  a scan with `--project` and a history window with fractional seconds.
- **Checks.** The Node tests, lint, the dependency rules, `check:collector-structure`, the three
  schemas, the collector scenarios and the API and PostgreSQL scenarios pass on Node.js 26.13.1.
- **Parser tests.** Seven `*-parser-*golden.test.ts` files pin the saved state and the output of each
  parser as exact text. After step 2 they are in
  [test/unit/providers/codex](../../apps/collector/test/unit/providers/codex) and
  [test/unit/providers/claude](../../apps/collector/test/unit/providers/claude). They cover one
  continuous scan, a restore from each saved state, a Codex fork, Codex paginated history, the Codex
  lookahead, the version upgrade of both parsers, a Claude Code subagent and an earlier Claude Code
  copy. A swap of two keys in one `snapshot()` fails 16 of these tests and no other test.

Results of step 2:

- **Moves.** 37 source files and 33 test files have a new path or a new name. A moved file changed
  only in its import lines, with two exceptions. Each of the seven golden tests names its new compiled
  path in one comment line. `storage/http/collector-wire-contract.ts` reads the schema bundle by a
  path relative to its own file, and that path has one more `../`.
- **Review check.** A script compared each TypeScript file of the collector, the API and the shared
  package with its content before the step. The text outside the import statements is identical,
  except for the eight lines above. Each import names the same module and the same names as before.
- **Output comparison.** `scan --once` and `history` give the same bytes as before step 2 on a new
  frozen sample. The sample has plain and compressed Codex rollouts, archived rollouts, and Claude Code
  transcripts with subagents. The comparison ran seven commands. Five ran the source on Bun: a full
  scan, a full history window, a scan with `--session`, a scan with `--project` and a history window
  with fractional seconds. Two ran the compiled files on Node.js: a full scan and a history window.
  For each command the standard output, the standard error and the exit code are the same.
- **Checks.** From a clean build on Node.js 26.13.1, these pass: the Node tests, lint, the dependency
  rules, `check:collector-structure`, the three schemas, the collector scenarios, the API and
  PostgreSQL scenarios, the shared logging checks, Knip and Habit Hooks.
- **Rules.** `storage-is-self-contained` is on. A test added one forbidden line to a file for each
  changed dependency rule and for the structure rule. Each of the eleven lines made its check fail. A
  function in a `pending` file did not.
- **Files with no change.** `knip.json` and `apps/api/component.yaml` name no moved path. No API
  source file changed.

Results of step 3:

- **The port.** [scan-provider.ts](../../apps/collector/src/scan/scan-provider.ts) has `ScanProvider`
  and `ProviderScan`, the interface for one scan pass. `CodexHistory` and `ClaudeHistory` implement
  `HistoryProvider` and `ScanProvider`. `CodexScan` and `ClaudeScan` are their pass classes.
  `LocalCollector` receives one options object. `LocalProviders.fromConfig` gives the list of providers
  for the reader and for the scanner.
- **The ten provider decisions.** Each row of the table in
  [step 3](#step-3-the-scanner-receives-its-providers) is behind the port. No row stayed in the engine.
  `scan/` and `watch/` import nothing from `providers/`, and `scan/` does not test the name of a
  harness. `scan/` imports only the storage port and the transcript layer. `scan/transcript-cursor.ts`
  names no provider field.
- **Output comparison.** After each of the four code commits, `scan --once` and `history` give the same
  bytes as before step 3 on a new frozen sample. The sample has plain, compressed and archived Codex
  rollouts, Codex sessions with a fork parent, and Claude Code transcripts with subagents. The
  comparison ran 13 commands. Ten ran the source on Bun, and three ran the compiled files on Node.js.
  For each command the standard output, the standard error and the exit code are the same. The
  commands are:
  - a full scan with an installation ID, and a full scan without one;
  - a full history window, and a history window with fractional seconds;
  - a scan with `--session`, and a scan with `--project`;
  - a fork child alone, the fork child with its parent, and a fork child whose parent is not in the
    sample;
  - a scan with no Claude Code root.
- **Trace comparison.** The CLI output does not show the sequence of the work. A second check recorded
  each `open`, `stat` and `readdir` of a transcript path, and each storage call. For a storage call it
  recorded a digest of the arguments and a digest of the result. It ran twelve scenarios before step 3
  and after each code commit. Each trace is identical. The scenarios are:
  - two scans with root-based stream IDs, and two scans with an installation ID;
  - a fork child alone, then with its parent, which corrects the accepted usage of the fork;
  - a project selection, then a session selection;
  - checkpoints of an earlier collector that have no `codexFork` and no `claudeCallOrigins`, which
    cause fork corrections and origin backfills;
  - checkpoints that have no evidence version, which cause evidence repairs;
  - a scanner for Codex alone, then a scanner for both providers on the same workspace;
  - earlier copies of Claude Code transcripts when the current file is absent, with a copy that has
    the same bytes, a longer copy and a shorter copy;
  - a Codex fork child that gets a new inode during the scan, so that the scanner discovers that
    file again;
  - one collector that scans three times, and one collector that scans while files go away and
    return.
- **Review.** Two independent reviews compared the old statements with the new statements. One read
  the commit of rows 2 to 8. The other read the commits of rows 9 and 10. They found no input of a
  real scan that gives a different result. The second review asked for two changes to the port of
  row 10, and that commit has them. A correction resumes through the format that it receives, as the
  old lines did. A correction can add only a batch field that holds an earlier checkpoint.
- **Checks.** On Node.js 26.13.1, these pass at each commit of step 3: the Node tests, lint, the
  dependency rules, `check:collector-structure`, the three schemas, the collector scenarios, the API
  and PostgreSQL scenarios, the shared logging checks, Knip and the Habit Hooks ESLint rules.
- **Rules.** `scan-engine-is-provider-neutral` and `only-local-providers-names-both-providers` are on,
  and they have no pending list. A test added eight forbidden imports and three top-level functions,
  one at a time: in `scan/`, `watch/`, `commands/`, `cli.ts`, `transcript/` and three provider files.
  Each of the eleven lines made its check fail.
- **Changes for a TypeScript caller.**
  - `new LocalCollector(config, storage, ...)` is now `new LocalCollector({ providers, storage, ... })`.
  - A scanner for one provider is possible. Three scenarios in
    [scan-providers.feature](../../apps/collector/test/acceptance/scan/scan-providers.feature) show it.
  - `LocalProviders.fromConfig` gives objects that implement both ports. `CodexHistory` and
    `ClaudeHistory` have a public `root` and `openScan`.
  - A discovered Codex source has no `previousCopy`. The source types are `CodexRolloutSource` and
    `ClaudeTranscriptSource`. `ClaudeSubagent` is an export of `./providers`, not of `./transcript`.
  - `readBatches` gives a `recordPrefixDigest` only to the conversation records of its provider.
    Before, it gave one to a record of each of the four types for each provider.
  - `ParserFormat` has `checkpointFields` in place of `codexFork` and `claudeCallOrigins`.
  - `SourceSightings.capture` receives the result of `locate`.
- **Two differences that the scanner cannot reach.** The reviews found them, and no input of a real
  scan gives them.
  - `CodexScan.parserFor` throws an `Error` when no discovery ran before it. The old closure threw a
    `TypeError` there. The scanner selects a parser only for a source that a discovery gave.
  - A parser state that no collector can write can name a line after its checkpoint as the first
    copy of a later message. If that line is a Codex record of type `user`, the old scanner added a
    prefix digest for that line to `messageOrigins`, and the new scanner does not. A collector writes
    only positions at or before its checkpoint, and it names only an `event_msg` record as such a
    first copy.
- **Files with no change.** The storage and HTTP contracts, `apps/collector/src/storage/`,
  `apps/api/src/` and each golden text.

The later steps must know these points:

- **A restored parser can write different text.** A parser that resumes from a checkpoint does not
  always give the same key order as one continuous scan. Five cases are known. The parser tests pin
  each case as it is, and three tests have the name "known restore difference, kept as it is". The
  cleanup must keep this behavior. A change to it is a separate decision.
- **Two block builders, two key orders.** Paginated Codex items build a text block as
  `{ blockIndex, text }`. Legacy Codex records build it as `{ text, blockIndex }`. The fallback message
  ID hashes the block, so step 4a must keep the two builders apart.
- **Functions that step 3 left.** `scan/` has 25 top-level functions and `watch/` has 4. Step 4c has 42
  functions now. `claude-source-copy.ts` is in the `pending` list. Its new class `ClaudeEarlierCopies`
  calls the functions `assessClaudeCopies` and `unreadableCopy` of the same file, and they are not
  exports now. Step 4b can make them members of that class.
- **The pass classes.** `CodexScan` and `ClaudeScan` receive their history class as a narrow type: a
  `Pick` of the methods that they call. In each provider directory the history file imports the pass
  file, and the pass file imports the type of the history class.
- **Methods that only a pass and the tests call.** `discoverSources`, `confirmedAbsent`, `identitiesAt`
  and `recoveryCandidates` stay public on `CodexHistory` and `ClaudeHistory`. `readRollouts` and
  `readTranscripts` are still the test-only methods of decision 2.
- **The types of the port.** The members of `ScanProvider`, `ProviderScan`, `EarlierCopies` and
  `ParserFormat` are methods. Thus a provider that has its own entry type and source type fits the
  default type of the port. Keep them as methods. The compiler does not check three things that the
  code does by construction. The scanner gives a pass only the sources that this pass discovered. The
  scanner keeps each pass with its own presence scan. `locate` gives a location whose root is the root
  of its provider.
- **Contract fields that stay in `scan/`.** `scan/scan-recovery.ts` reads `codexFork` and
  `claudeCallOrigins` of a checkpoint. `scan/decoded-chat.ts`, `scan/transcript-cursor.ts` and
  `scan/local-collector.ts` name `claudeUsageReports`, `codexCallClaims` and `codexCallAliases`,
  because they are fields of `Batch`. `scan/source-presence.ts` reads `currentFileCwd` of a
  `SourceLocation`. These are fields of the storage contract, not provider decisions.
- **Imports from `providers/` to `scan/`.** Sixteen provider files import seven `scan/` files:
  `parser-state.ts`, `decoded-chat.ts`, `transcript-cursor.ts`, `scan-provider.ts`, `scan-recovery.ts`,
  `scan-pending.ts` and `source-sightings.ts`. No rule forbids this direction.
- **`watch/` imports `scan/`.** The two `watch/` files import six `scan/` files. `scan/` imports nothing
  from `watch/`, because the type `ScanProgress` is in `scan/scan-progress.ts` now.
- **The package export `./scan`.** It exports `LocalCollectorOptions` and the port types that a
  provider needs: `ScanProvider`, `ProviderScan`, `LocatedSource`, `IdentityInventory`, `ParserFormat`,
  `ProviderCheckpointFields`, `ReplacedCheckpointFields`, `UsageCorrection`, `SavedDecoder`,
  `ChatParser` and `DecodedChat`. The mock provider and the tests import them through the package.
  Knip does not see an import through `#src/…`.
- **The command builds its providers one time.** Before step 3 the scanner built them for each scan
  pass. Each pass still opens a new pass object. The history classes keep no state between passes.
- **Test fixtures of step 3.** `ConfiguredCollector` builds a collector from a configuration.
  `MockScanProvider` and `RecordingCollectorStorage` are the mock adapters for a unit test of the
  engine. `ScanPassFixture` and `ProviderHistoryStub` are for a unit test of a pass class.
- **The trace comparison is the check for step 4c.** Step 4c changes the engine again. Record each
  file operation and each storage call on a frozen sample before the change and after it. The
  scenarios in the results of step 3 reach the paths that the CLI output does not show.
- **Shared leaf modules.** `recorded-instant.ts` and `claude-transcript-copy.ts` are in
  `packages/shared/src`, and `@tracerelic/shared` exports their six names. The structure rule applies
  only to `apps/collector/src`, so it does not see their four functions. Step 4 makes
  `RecordedInstant` and `ClaudeTranscriptCopy` and must extend the rule to these two files. Bun and
  Node.js load `@tracerelic/shared` from `packages/shared/dist`. Run `bun run build` after a change to
  the shared package and before `bun run collector`.
- **Stale test names.** `local-llm-history-codex.test.ts`, `local-llm-history-claude.test.ts` and
  `transcript-replay.test.ts` keep the names of files that no longer exist. Step 5 can give them new
  names.
- **Bun and Node.js give a different order.** For the same sample at the same commit, the Bun run of
  the source and the Node.js run of the compiled files do not give the same bytes. The content is the
  same, but the order of the sessions and of some messages is different. Compare the output of one
  runtime with the output of the same runtime.
- **`JsonlRecords.isRecord`** is the plain-object check of the transcript layer. The `JsonRecord` class
  of step 4 takes it over.
- **`SourceDiscovery`** in `transcript/source-discovery.ts` owns the selection by session and project.
  The package has the exports `./providers` and `./transcript` from step 2.

## Baseline

| Directory | Files | Lines | Classes | Top-level functions |
| --- | ---: | ---: | ---: | ---: |
| `src/` root | 3 | 90 | 0 | 6 |
| `commands/` | 1 | 115 | 1 | 4 |
| `config/` | 4 | 102 | 2 | 0 |
| `history/` | 7 | 1,027 | 6 | 7 |
| `scan/` | 26 | 3,851 | 26 | 98 |
| `storage/` | 24 | 4,003 | 22 | 150 |
| **Total** | **65** | **9,188** | **57** | **265** |

Of the 265 functions, 68 are exported. Thirteen files contain functions and no class.

With the pinned Node.js 26.13.1, all 687 workspace tests and the 47 collector scenarios pass. Lint and
the dependency rules pass. The Habit Hooks size limits pass for `apps/collector/src`. The API and
PostgreSQL scenario suites were not run for this review. Node.js 24.20 fails one compressed-rollout
test, so run `nvm use` before each check.

## Findings

### 1. The date reader exists, but inheritance hides it

[`LocalLLMHistory`](../../apps/collector/src/history/local-llm-history.ts#L109) is an abstract class
with `readLocalHistory(fromDate, toDate)`. `LocalLLMHistoryCodex` and `LocalLLMHistoryClaude` extend
it. Nothing is injected. No class reads both providers. The command builds the two readers and joins
their results itself at
[collector-command.ts:81](../../apps/collector/src/commands/collector-command.ts#L81). The scanner
builds the same two readers again at
[local-collector.ts:134](../../apps/collector/src/scan/local-collector.ts#L134).

### 2. The base class does three jobs

| Job | Lines in `local-llm-history.ts` |
| --- | --- |
| Check a date window and filter by timestamp | 114–135 |
| Build scan sources, apply the session and project selection | 137–185 |
| Split JSONL lines, decode JSON, cut byte-bounded batches, hash prefixes | 187–297 |

Each provider class inherits all three through `protected` helpers. Each provider class also finds
files, reads headers, answers date queries, discovers scan sources and checks for missing files.

### 3. Provider knowledge is in four places, and the scan engine names both providers

Codex code is in `history/` (2 files), `scan/` (9 files) and `storage/` (5 files). Claude code is in
the `src/` root (1 file), `history/` (1 file), `scan/` (5 files) and `storage/` (7 files). The engine
that should be provider-neutral contains these provider decisions:

| Provider decision in the engine | Where it is now |
| --- | --- |
| Construct the Codex and Claude readers | [local-collector.ts:134](../../apps/collector/src/scan/local-collector.ts#L134) |
| Skip Claude when `claudePath` is absent | [local-collector.ts:137](../../apps/collector/src/scan/local-collector.ts#L137) and four checks in `local-llm-history-claude.ts` |
| Codex fork evidence shared through a closure variable | [local-collector.ts:142](../../apps/collector/src/scan/local-collector.ts#L142) |
| Claude parser selection | [local-collector.ts:148](../../apps/collector/src/scan/local-collector.ts#L148) |
| One source for each Codex file, many sessions for each Claude file | [local-collector.ts:64](../../apps/collector/src/scan/local-collector.ts#L64) |
| Logical file name: strip `.zst` for Codex only | [local-collector.ts:84](../../apps/collector/src/scan/local-collector.ts#L84) |
| Claude earlier-copy fields and copy recovery | [local-collector.ts:54](../../apps/collector/src/scan/local-collector.ts#L54), [:230](../../apps/collector/src/scan/local-collector.ts#L230) |
| Stream ID and location for each provider | [source-sightings.ts:59](../../apps/collector/src/scan/source-sightings.ts#L59) |
| Codex identity repair | [source-presence.ts:94](../../apps/collector/src/scan/source-presence.ts#L94) |
| Codex fork and Claude origin flags in the cursor | [transcript-cursor.ts:13](../../apps/collector/src/scan/transcript-cursor.ts#L13), [:118](../../apps/collector/src/scan/transcript-cursor.ts#L118) |
| Provider fields on the generic source type (`codexForkHeader`, `codexHeaderEnd`, `claudeSubagent`, `currentFileCwd`, `currentFilePath`) | [local-llm-history.ts:69](../../apps/collector/src/history/local-llm-history.ts#L69) |
| Provider record types named in the generic line reader | [local-llm-history.ts:236](../../apps/collector/src/history/local-llm-history.ts#L236) |

A third provider would require edits in each of these places.

### 4. Functions outnumber classes by more than four to one

- **Function-only modules (13 files, 105 functions).** For example
  [codex-usage-report.ts](../../apps/collector/src/providers/codex/codex-usage-report.ts) has 15 functions and
  [checkpoint-validation.ts](../../apps/collector/src/storage/checkpoint-transition.ts) has 18.
- **Exported helpers beside a class (26 functions).** For example `readStorage`, `captureProof` and
  three more in [scan-recovery.ts](../../apps/collector/src/scan/scan-recovery.ts).
- **Private helpers beside a class (134 functions).** For example 15 below `CodexChat` and 25 in
  [usage-windows.ts](../../apps/collector/src/storage/codex/usage-windows.ts).

The same small rule is written several times:

| Rule | Copies |
| --- | --- |
| "Value is a plain object" | `claude-chat.ts:96`, `codex-chat.ts:386`, `codex-usage-counts.ts:10`, `claude-usage-counts.ts:7`, `usage-validation.ts:20`, `local-llm-history.ts:152` |
| "Value is a nonempty string" | `claude-chat.ts:92`, `codex-chat.ts:390`, `codex-usage-report.ts:25`, `usage-validation.ts:16` |
| "Value is a nonnegative safe integer" | `claude-usage-counts.ts:11`, `codex-usage-counts.ts:14`, `usage-validation.ts:12` |
| Encode a stream key or session key as text | `source-sightings.ts:7`, `scan-activity.ts:38`, `in-memory-collector-storage.ts:18` and `:22` |
| The list of token breakdown fields | `codex-usage-counts.ts:4`, `usage-windows.ts:5` |
| "Is this Claude row a real assistant message" | `claude-chat.ts:54`, `claude-usage.ts:15` |
| `Seen<Entry>` and `VerifiedPrefix` types | `source-presence.ts:17` and `codex-identity-repair.ts:8`; `local-llm-history.ts:59` and `collector-storage.ts:131` |

### 5. Directories mix concerns

- **`scan/` holds three things.** Provider parsers and provider recovery (14 files), the import engine
  (10 files) and the watch schedule (2 files).
- **`storage/` holds four things.** The port (1 file), the HTTP client and wire format (3 files),
  provider accounting rules (12 files) and the session model (8 files). The port file has 403 lines.
  It mixes the contract types with seven functions and three error classes.
- **Two files sit loose in `src/`.** `recorded-timestamp.ts` and `claude-transcript-copy.ts` are there
  because history, scan and storage all import them. The API also loads them through `storage/`. The
  dependency rule that limits the API to `storage/` does not see this.
- **`cli.ts` is two functions.** `commands/collector-command.ts` parses arguments, loads the
  configuration, builds readers, builds the scanner and runs the schedule.

### 6. The size limits helped to produce this shape

[Habit Hooks](../../.habit-hooks/eslint.config.mjs) allows 500 lines for each file and 60 lines for
each function. `usage-windows.ts` has 485 lines, `codex-chat.ts` 471 and `codex-usage.ts` 429. The file
limit is the likely reason that logic left a large class for a sibling file of functions. For example
`codex-usage-report.ts` and `codex-usage-counts.ts` sit beside `codex-usage.ts`. The cleanup cannot put
those helpers back into the same large class. It must give each group of helpers its own small class.

### 7. Tests reach the source in three ways

Tests import through the package exports (`@tracerelic/collector/history`), through `#src/…` and
through relative `../../../src/…` paths. Knip cannot resolve the `#src/…` form. Four production
methods have test callers only: `readRollouts`, `readTranscripts`, `ClaudeChat.decode` and
`CodexChat.decode`.

## Target structure

```text
apps/collector/src/
├── cli.ts                     CollectorCli: logger, standard output, exit codes
├── commands/
│   ├── collector-command.ts   CollectorCommand: builds the providers, the reader, the scanner, the schedule
│   └── command-arguments.ts   CommandArguments: parses and checks the CLI options
├── config/                    no change
├── history/                   the date reader
│   ├── index.ts               package export ./history
│   ├── local-llm-history.ts   LocalLLMHistory: readLocalHistory(from, to) over the injected providers
│   ├── history-provider.ts    HistoryProvider (port), LocalHistoryEntry
│   └── history-window.ts      HistoryWindow: checks the bounds, tests one timestamp
├── providers/
│   ├── index.ts               package export ./providers
│   ├── local-providers.ts     LocalProviders.fromConfig(config): the only file that names both providers
│   ├── codex/                 all code that knows Codex files and records
│   │   ├── codex-history.ts          CodexHistory: implements HistoryProvider and ScanProvider
│   │   ├── codex-scan.ts             CodexScan: one scan pass, with the fork evidence of its latest discovery
│   │   ├── codex-rollout-files.ts    sessions/, archived_sessions/, plain and .zst forms
│   │   ├── codex-session-header.ts   session ID, working directory, fork parent
│   │   ├── codex-session-parser.ts, codex-chat.ts, codex-visible-text.ts
│   │   ├── codex-usage.ts, codex-usage-report.ts, codex-token-counts.ts
│   │   └── codex-fork-*.ts, codex-identity-repair.ts, codex-rollout-copies.ts
│   └── claude/                all code that knows Claude Code files and records
│       ├── claude-history.ts         ClaudeHistory: implements HistoryProvider and ScanProvider
│       ├── claude-scan.ts            ClaudeScan: one scan pass
│       ├── claude-transcript-files.ts   projects/, subagents/, earlier copies
│       ├── claude-session-identity.ts   native ID, subagent ID
│       ├── claude-session-parser.ts, claude-chat.ts, claude-visible-text.ts
│       └── claude-usage.ts, claude-usage-counts.ts, claude-source-copy.ts
├── transcript/                provider-neutral file reading
│   ├── captured-transcript-file.ts, transcript-directories.ts
│   ├── jsonl-records.ts       JsonlRecords: complete lines to JSON objects
│   ├── transcript-batches.ts  TranscriptBatches: byte-bounded batches with prefix digests
│   └── transcript-source.ts   TranscriptSource, RecordBatch, ReadPosition, ScanSelection
├── scan/                      provider-neutral import engine
│   ├── local-collector.ts     LocalCollector: scanOnce, scanForChanges; receives providers and storage
│   ├── scan-provider.ts       ScanProvider and ProviderScan (port)
│   ├── scan-progress.ts       ScanProgress: what the scanner tells the watch schedule
│   ├── transcript-cursor.ts, parser-state.ts, replay-occurrences.ts, decoded-chat.ts
│   ├── scan-recovery.ts, checkpoint-proof.ts, source-presence.ts, source-sightings.ts
│   └── scan-pending.ts, scan-rejected.ts
├── watch/
│   └── scheduled-scanner.ts, scan-activity.ts
└── storage/                   the API imports only this directory
    ├── collector-storage.ts   the port: contract types, CollectorStorage, error classes
    ├── in-memory-collector-storage.ts, checkpoint-transition.ts, batch-values.ts
    ├── session-messages.ts, session-metadata.ts, session-usage.ts
    ├── source-inventory.ts, source-usage-diagnostics.ts
    ├── http/                  HttpCollectorStorage, CollectorWireContract, PackedBatch
    ├── claude/                usage ledger, call owners, origin reports, advisor iterations
    └── codex/                 call aliases, call owners, source identity, usage windows
```

### The date reader

```ts
// history/history-provider.ts
export interface HistoryProvider {
  readonly harness: Harness;
  /** Read the raw records with a recorded timestamp in the window, in file order. */
  readHistory(window: HistoryWindow): Promise<readonly LocalHistoryEntry[]>;
}

// history/local-llm-history.ts
export class LocalLLMHistory {
  constructor(private readonly providers: readonly HistoryProvider[]) {}

  readLocalHistory(fromDate: Date, toDate: Date): Promise<readonly LocalHistoryEntry[]>;
  readLocalHistoryInstants(from: string, to: string): Promise<readonly LocalHistoryEntry[]>;
}

// commands/collector-command.ts
const providers = LocalProviders.fromConfig(config);   // CodexHistory, and ClaudeHistory if configured
const entries = await new LocalLLMHistory(providers).readLocalHistoryInstants(from, to);
```

`LocalLLMHistory` checks the window one time and reads the providers together. It returns their
records in the injection order. A provider receives its root path, not the configuration object. If the
configuration has no `claudePath`, no Claude provider is injected. The five `claudePath` checks go away.

### The scanner

`LocalCollector` receives the same provider objects through a second, narrow port. Step 3 fixed the
shape of this port. The contract is in [scan.tsp](local-collector/scan.tsp).

```ts
// scan/scan-provider.ts
export interface ScanProvider<Entry extends SourceLine = SourceLine, Source extends TranscriptSource<Entry> = TranscriptSource<Entry>> {
  readonly harness: Harness;
  readonly root: string;
  /** One pass over the selected files. The pass keeps its own state, such as Codex fork evidence. */
  openScan(selection: ScanSelection): ProviderScan<Entry, Source>;
}

export interface ProviderScan<Entry extends SourceLine = SourceLine, Source extends TranscriptSource<Entry> = TranscriptSource<Entry>> {
  /** Sources that share one physical file arrive together. */
  discoverFiles(options: SourceDiscoveryOptions): AsyncIterable<readonly Source[]>;
  /** The name that the physical forms of one file share. Absent when each file has one form. */
  logicalName?(sourceFile: string): string;
  parserFor(source: Source, checkpoint: Checkpoint | null): ParserFormat<Entry> | Promise<ParserFormat<Entry>>;
  /** The location of a source, and its stream ID for a collector that has no installation ID. */
  locate(source: Source): LocatedSource;
  confirmedAbsent(paths: readonly string[], excludedCopyPaths?: readonly string[]): Promise<readonly string[]>;
  /** Codex only: check the identity of the acknowledged sources that this pass did not see. */
  repairIdentities?(inventory: IdentityInventory<Source>): Promise<readonly StreamKey[]>;
  /** Claude Code only: the earlier copies that can continue an absent current file. */
  readonly earlierCopies?: EarlierCopies<Entry, Source>;
}

// scan/transcript-cursor.ts: the parser of one source also has the provider rules for its checkpoints
export interface ParserFormat<Entry> {
  version: number;
  gapVersion?: number;
  /** codexFork for a Codex fork, claudeCallOrigins for Claude Code. */
  checkpointFields?: ProviderCheckpointFields;
  /** Present when the accepted checkpoint lacks what this format records now. */
  correction?(accepted: Checkpoint): UsageCorrection<Entry> | undefined;
  /** For a source that adds to the session of another file, such as an earlier Claude Code copy. */
  prepareBatch?(chat: DecodedChat, known: SessionView | null, expectedOffset: number): boolean;
  resume(state?: unknown): ChatParser<Entry>;
  upgrade?(oldDecoder?: object): ...;
}

new LocalCollector({ providers, storage, installationId, onRejection, onMissing, progress });
```

Each row of the table in finding 3 is behind this port. `scan/` and `watch/` do not import
`providers/`. The table in [step 3](#step-3-the-scanner-receives-its-providers) gives the port member
for each row.

## Where the current files go

| Now | Target | Change |
| --- | --- | --- |
| `cli.ts` | `cli.ts` | Same path. The two functions become `CollectorCli`. All logger calls stay in this file. |
| `commands/collector-command.ts` | `commands/collector-command.ts`, `commands/command-arguments.ts` | Four functions become `CommandArguments`. |
| `recorded-timestamp.ts` | `packages/shared/src/recorded-instant.ts` | `RecordedInstant` class. See decision 4. |
| `claude-transcript-copy.ts` | `packages/shared/src/claude-transcript-copy.ts` | `ClaudeTranscriptCopy` class. See decision 4. |
| `history/index.ts` | `history/index.ts`, `providers/index.ts` | The reader and its port stay in `./history`. The provider classes move to `./providers`. |
| `history/local-llm-history.ts` | `history/local-llm-history.ts`, `history/history-provider.ts`, `history/history-window.ts`, `transcript/jsonl-records.ts`, `transcript/transcript-batches.ts`, `transcript/transcript-source.ts` | Split by the three jobs in finding 2. |
| `history/captured-transcript-file.ts`, `history/transcript-directories.ts` | `transcript/` | Move. |
| `history/local-llm-history-codex.ts`, `history/codex-rollout-copies.ts` | `providers/codex/codex-history.ts`, `codex-rollout-files.ts`, `codex-session-header.ts`, `codex-rollout-copies.ts` | Stop extending the base class. Split file finding from header reading. |
| `history/local-llm-history-claude.ts` | `providers/claude/claude-history.ts`, `claude-transcript-files.ts`, `claude-session-identity.ts` | Same. |
| `scan/codex-*.ts` (9 files) | `providers/codex/` | Move. `codex-usage-counts.ts` becomes `codex-token-counts.ts`. |
| `scan/claude-*.ts` (5 files) | `providers/claude/` | Move. |
| `scan/local-collector.ts`, `transcript-cursor.ts`, `decoded-chat.ts`, `scan-recovery.ts`, `scan-pending.ts`, `scan-rejected.ts`, `source-presence.ts`, `source-sightings.ts` | `scan/` | Stay. |
| `scan/chat-parser-state.ts`, `scan/transcript-replay.ts` | `scan/parser-state.ts`, `scan/replay-occurrences.ts` | Rename for the class each file holds. |
| `scan/scheduled-scanner.ts`, `scan/scan-activity.ts` | `watch/` | Move. |
| `storage/collector-storage.ts` | `storage/collector-storage.ts` | Same path. Seven functions become `LegacyScannerSource` and `SourceScopes` in the same file. |
| `storage/http-collector-storage.ts`, `collector-wire-contract.ts`, `collector-batch-wire.ts` | `storage/http/` | Move. `collector-batch-wire.ts` becomes `packed-batch.ts`. |
| `storage/claude-*.ts` (7 files) | `storage/claude/` | Move. |
| `storage/codex-*.ts` (3 files), `usage-windows.ts`, `observed-counter-spans.ts` | `storage/codex/` | Move. |
| `storage/checkpoint-validation.ts`, `usage-validation.ts` | `storage/checkpoint-transition.ts`, `storage/batch-values.ts` | Rename for the class each file holds. |
| The other six `storage/` files and `config/` | Same path | Stay. |

Test files follow their subject, as the [test layout](../engineering-guidelines/coding-principles.md#test-locations)
requires. For example `test/unit/scan/codex-chat.test.ts` moves to `test/unit/providers/codex/`. The
feature files stay where they are. The package export names stay the same, so the API source keeps
its import paths. One export is new: `@tracerelic/collector/providers`.

## Functions to classes

**Rule.** No file in `apps/collector/src` declares a top-level function. Each helper goes to one of
three places:

1. **A private method of the class in the same file.** Use this when only that class calls the helper
   and the file stays below 500 lines.
2. **A small value or policy class with its own file.** Use this when several helpers share one subject.
3. **One shared class.** Use this when the same rule exists in more than one file (finding 4).

No step changes the logic of a helper. A step changes only where the helper lives and how a caller
names it.

| Now | Functions | Becomes |
| --- | ---: | --- |
| `recorded-timestamp.ts` | 3 | `RecordedInstant`: `parse`, `compareTo`, `isTimestamp` |
| `claude-transcript-copy.ts` | 1 | `ClaudeTranscriptCopy`: `stem`, `fallbackFields` |
| `cli.ts` | 2 | `CollectorCli`: `run`, private `configuredStorage` |
| `commands/collector-command.ts` | 4 | `CommandArguments` |
| `history/codex-rollout-copies.ts` | 1 | `CodexRolloutCopies` |
| `scan/codex-usage-counts.ts` | 9 | `CodexTokenCounts`: `fromProvider`, `restore`, `sameTotals`, `minus`, `partition`, `mergeRepeated` |
| `scan/codex-usage-report.ts` | 15 | `CodexUsageReport` and `CodexCallContext` |
| `scan/codex-chat.ts` | 15 | `CodexVisibleText` (7 functions that decide which text is visible); the other 8 become private methods of `CodexChat` or calls to `JsonRecord` |
| `scan/claude-chat.ts`, `scan/claude-usage.ts` | 8 | `ClaudeVisibleText`; one `ClaudeAssistantRecord` for the rule that both files repeat |
| `scan/transcript-replay.ts` | 5 | `ReplayOccurrences`: `restore`, `plan`, `count`, `reconcile` |
| `scan/chat-parser-state.ts` | 4 | `ParserState`: `record`, `string`, `digest`, `invalid` |
| `scan/scan-recovery.ts` | 5 | `CheckpointProof`: `prefixes`, `verifiedBy`, `capture`, `same`; `readStorage` becomes a method of the storage reader that the scan classes share |
| `storage/checkpoint-validation.ts` | 18 | `CheckpointTransition`: `new CheckpointTransition(batch, current).failure()` |
| `storage/session-usage.ts` | 13 | `SessionUsage`, in the form of `SessionMessages` and `SessionMetadata` |
| `storage/usage-validation.ts` | 14 | `BatchValues` |
| `storage/usage-windows.ts` | 26 | `UsageIntervals` (new file for the interval rules); the others become private methods |
| `storage/collector-batch-wire.ts` | 8 | `PackedBatch`: `pack`, `unpack`, `digest` |
| `storage/observed-counter-spans.ts` | 11 | `ObservedCounterSpans` |
| `storage/codex-source-identity.ts` | 5 | `CodexSourceIdentity` |
| `storage/collector-storage.ts` | 7 | `LegacyScannerSource`, `SourceScopes` |
| Plain-object, string and count checks (13 copies) | — | `JsonRecord` in `transcript/` for the readers and parsers; `BatchValues` for storage |
| Stream key and session key text (4 copies) | — | `StreamKeys` in the port file |
| The other private helpers | about 90 | Private methods of the class in the same file |

## Constraint decisions

| Constraint | Decision and check |
| --- | --- |
| Behavior | No change that a user or a caller of the CLI can see. The 47 scenarios and 687 tests are the specification. Two scenarios are new, because a reader that receives its providers is new for a TypeScript caller. They are in [history-providers.feature](../../apps/collector/test/interface/history/history-providers.feature). Check with `bun run check:collector-history`, `check:collector-scan`, `check:collector-storage` and `bun run test`. |
| Observability | Out of scope. No signal is added or changed. Each diagnostic keeps `cli.ts` as its calling file, because every logger call stays in `cli.ts`. The CLI tests match that prefix. |
| Architecture | Add the rules below to [.dependency-cruiser.collector.json](../../.dependency-cruiser.collector.json). Add one ESLint rule that forbids a top-level function in `apps/collector/src`. Check with `bun run check:collector-deps` and a new `bun run check:collector-structure`. Add the new check to the [PR workflow](../../.github/workflows/collector.yml). |
| Interface | [history.tsp](local-collector/history.tsp): `LocalLLMHistory` keeps its two operations, and `HistoryProvider` is new. [scan.tsp](local-collector/scan.tsp): `CodexHistory` and `ClaudeHistory` replace the two interfaces that extend `LocalLLMHistory`. `ScanProvider` is new. `TranscriptSourceInfo` loses its provider fields, and each provider declares its own source model. The storage and HTTP contracts do not change. Check with `bun run schema:collector-history` and `schema:collector-scan`. |

The new scenarios:

```gherkin
  Scenario: One reader returns Codex and Claude Code records for the same day
    Given Codex chat "c1" records "Plan search" and Claude Code chat "h1" records "Use an index" on February 1
    When I read February 1 UTC with one reader for both providers
    Then I get "Plan search" for "codex/c1" and then "Use an index" for "claude/h1"

  Scenario: A reader for Codex alone does not return Claude Code records
    Given Codex chat "c1" records "Plan search" and Claude Code chat "h1" records "Use an index" on February 1
    When I read February 1 UTC with a reader for Codex alone
    Then I get only "Plan search" for "codex/c1"
```

Dependency rules:

| Rule | Forbidden import | On from |
| --- | --- | --- |
| `history-reads-through-the-provider-port` | `history/` to `providers/`, `transcript/`, `scan/`, `watch/`, `storage/`, `config/`, `commands/` | Step 1 |
| `transcript-layer-is-provider-neutral` | `transcript/` to `providers/`, `scan/`, `watch/`, `storage/`, `config/`, `commands/` | Step 1 |
| `only-the-transcript-layer-reads-files` | `history/`, `providers/`, `scan/` to `node:fs`. Replaces `scanner-reads-files-through-history`. Step 2 adds `watch/`. | Step 1 |
| `providers-do-not-know-each-other` | `providers/codex/` to `providers/claude/`, and the reverse | Step 1 |
| `providers-receive-their-paths` | `providers/codex/` and `providers/claude/` to `config/`. `history-receives-global-config` continues to keep the configuration loader out of `history/`, `providers/` and `transcript/`. | Step 1 |
| `scan-engine-is-provider-neutral` | `scan/`, `watch/` to `providers/` | Step 3 |
| `only-local-providers-names-both-providers` | Any file of `apps/collector/src` outside `providers/` to `providers/codex/` or `providers/claude/` | Step 3 |
| `storage-is-self-contained` | `storage/` to any other collector directory | Step 2 |
| Existing rules for the HTTP client, the schedule and the storage port | Same meaning, new paths | Step 2 |

`scanner-uses-only-the-storage-port` is the existing rule for the storage port. Before step 2 it starts
from `scan/`. Step 2 moves some of these files to `watch/` and `providers/`, so the rule then starts
from `scan/`, `watch/` and `providers/`.

Step 3 turns on its two rules in its first commit, before the code changes. At that commit, three
`scan/` files import `providers/`: `local-collector.ts`, `source-presence.ts` and `source-sightings.ts`.
A `pathNot` list in each rule names these files, and the rule does not apply to them. The rule applies
to each other file from the first commit. Each later commit of step 3 removes the names that it clears.
At the end of step 3 the two rules have no `pathNot` list. A test file can import a provider file, so
the second rule starts only from `apps/collector/src`.

The structure rule is in [collector-structure.eslint.mjs](../../.habit-hooks/collector-structure.eslint.mjs).
Its `cleaned` list names the directories that have no top-level function. Habit Hooks applies the same
rule through its own configuration.

Step 2 moves 14 parser files into `providers/` before their cleanup. Ten of them have top-level
functions. A second list, `pending`, names these ten files, and the rule does not apply to them. The
rule continues to apply to `history/`, to the nine files that step 1 made in `providers/`, to the four
moved files that have no top-level function and to each new file in `providers/`. Step 4a removes the
six Codex names from `pending`. Step 4b removes the four Claude Code names. The list is then empty, and
the rule applies to all of `providers/` again.

## Steps

Each step is one draft PR and leaves all checks green. Each step ends with the comparison in step 0.

### Step 0. Safety net and constraints

No production code changes.

1. **Pin the parser output.** Tests read `parserState` with `deepEqual`, which ignores key order. The
   scanner compares `parserState` as a string
   ([scan-recovery.ts:44](../../apps/collector/src/scan/scan-recovery.ts#L44)). Message IDs and call IDs
   are hashes of JSON text. Add one unit test for each provider parser. It feeds fixed in-memory records
   and expects the exact `snapshot()` text, message IDs and usage IDs.
2. **Compare with `main`.** Live sessions change the local history, so copy a sample of it to a scratch
   directory and make the copy read-only. Copy only the transcript directories (`sessions/`,
   `archived_sessions/` and `projects/`), not the other files of `~/.codex` and `~/.claude`. Run
   `collector scan --once` and `collector history` on that copy from `main` and from the branch. Include
   one run with `--session`, one run with `--project` and one window with fractional seconds. The
   standard output must be identical byte for byte. Run the commands two times on `main` first, to
   confirm that the output is stable. Nothing leaves the computer.
3. **Write the constraints for the next step.** Add the scenarios, the TypeSpec changes and the
   dependency rules that the step makes true. The ESLint rule lists the cleaned directories. Each later
   step adds the directories that it has cleaned.

The sample for steps 0 and 1 had plain and compressed Codex rollouts, archived rollouts, and Claude Code
transcripts with subagents. Each message in the sample had a native ID. Only the parser tests of item 1
cover the fallback text IDs.

### Step 1. The history reader receives its providers

1. Red: the new scenarios, and a unit test of `LocalLLMHistory` with two mock providers.
2. Split `local-llm-history.ts` by its three jobs. Create `HistoryWindow`, `JsonlRecords` and
   `TranscriptBatches`. Move `captured-transcript-file.ts` and `transcript-directories.ts` to
   `transcript/`.
3. Create `CodexHistory` and `ClaudeHistory`. They implement `HistoryProvider`, receive a root path and
   use the transcript classes by composition. `providers/` starts with no top-level function, so
   `codexRolloutName` and `compatibleCodexCopies` become class members in this step.
4. Make `LocalLLMHistory` a concrete class. `CollectorCommand` builds it from `LocalProviders`. The
   scanner constructs the two providers itself until step 3.
5. Update 57 constructor calls in the tests and the README example.

Size: medium. About 1,000 lines of `history/` change shape.

### Step 2. Group the provider code and name the layers

Moves and import edits only. Move the parsers to `providers/`, the schedule to `watch/` and the
storage files to their subdirectories. Move the two shared leaf modules (decision 4). Move each test
file with its subject. Update the package exports,
[component.yaml](../../apps/collector/component.yaml), the Knip entries and the dependency rule paths.

A test file moves when the class or module that it tests has moved. A test of `LocalCollector`,
`CollectorCommand`, the CLI or `InMemoryCollectorStorage` stays, because its subject stays. A test file
keeps its name. The step definitions stay with their feature files.

Size: small risk, large diff. About 35 source files move or change name.

### Step 3. The scanner receives its providers

The four constraint decisions for this step:

| Constraint | Decision and check |
| --- | --- |
| Behavior | No change for a user of the CLI. Three scenarios are new, because a scanner that receives its providers is new for a TypeScript caller. Before this step the scanner always read Codex. The scenarios are below. Check with `bun run check:collector-scan` and `bun run test`. A unit test gives `LocalCollector` a mock `ScanProvider` and a mock storage. It shows that the engine needs no Codex class and no Claude Code class. |
| Observability | Out of scope. No signal is added or changed. Each logger call stays in `cli.ts`. |
| Architecture | `scan-engine-is-provider-neutral` and `only-local-providers-names-both-providers` are on from the first commit. Check with `bun run check:collector-deps`. |
| Interface | [scan.tsp](local-collector/scan.tsp): `ScanProvider`, `ProviderScan`, `ParserFormat`, `LocalCollectorOptions`, `CodexRolloutSource` and `ClaudeTranscriptSource` are new. `TranscriptSourceInfo` has only the session ID, the file and its size. The storage and HTTP contracts do not change. Check with `bun run schema:collector-scan`. |

The new scenarios:

```gherkin
Feature: Scan with one scanner for the providers that it receives

  Scenario: One scanner imports Codex and Claude Code chats
    Given Codex chat "c1" records "Plan search" and Claude Code chat "h1" records "Use an index"
    When I scan with one scanner for both providers
    Then the workspace has "Plan search" for "codex/c1" and "Use an index" for "claude/h1"

  Scenario: A scanner for Codex alone does not import Claude Code chats
    Given Codex chat "c1" records "Plan search" and Claude Code chat "h1" records "Use an index"
    When I scan with a scanner for Codex alone
    Then the workspace has only "Plan search" for "codex/c1"

  Scenario: A scanner for Claude Code alone does not import Codex chats
    Given Codex chat "c1" records "Plan search" and Claude Code chat "h1" records "Use an index"
    When I scan with a scanner for Claude Code alone
    Then the workspace has only "Use an index" for "claude/h1"
```

Each provider decision of finding 3 moves behind the port. The generic algorithm stays in the engine.
For example, the loop that imports an earlier copy stays in `LocalCollector`.

| # | Provider decision | Port member | Codex | Claude Code |
| --- | --- | --- | --- | --- |
| 1 | Construct the providers | `LocalCollectorOptions.providers` | `LocalProviders.fromConfig` | `LocalProviders.fromConfig`, only when `claudePath !== undefined` |
| 2 | Fork evidence and parser selection | `ProviderScan.parserFor`, and the state of the pass | `CodexScan` keeps the `CodexForkSources` of its latest discovery | `ClaudeSessionParser.forSource` |
| 3 | File grouping | `ProviderScan.discoverFiles` | One source for each group, as soon as it is discovered | All the selected sessions of one file together |
| 4 | Logical file name | `ProviderScan.logicalName`, optional | The rollout name without `.zst` | Absent |
| 5 | Stream ID, path and location | `ProviderScan.locate` | Path: the logical name. Root-based stream ID: the JSON array of the root and the path | Path: relative to the root. Root-based stream ID: the absolute file |
| 6 | Identity repair | `ProviderScan.repairIdentities`, optional | `CodexIdentityRepair` | Absent |
| 7 | Earlier copies of an absent file | `ProviderScan.earlierCopies`, optional | Absent | `recoveryCandidates`, `assessClaudeCopies`, `unreadableCopy`, `ClaudeSourceCopy` |
| 8 | A batch of an earlier copy | `ParserFormat.prepareBatch`, optional | Absent | The format of an earlier copy |
| 9 | Provider fields of a source, and the record types that get a prefix digest | The source type of each provider, and `SelectedFile.isConversation` | `CodexRolloutSource`; `response_item` and `event_msg` | `ClaudeTranscriptSource`; `user` and `assistant` |
| 10 | Provider fields of a checkpoint, and the correction of accepted usage | `ParserFormat.checkpointFields` and `ParserFormat.correction` | `codexFork` and `reconcileCodexForkFrom` | `claudeCallOrigins` and `backfillClaudeOriginsFrom` |

The engine applies one generic rule for the stream ID. With an installation ID, the stream ID is the
path of the location. Without one, it is the root-based stream ID of the provider.

The rules for each move:

- **No behavior change.** The scanner keeps the same sequence of file reads and storage calls, the same
  batches and checkpoints, and the same errors and messages. A Codex source goes to the import as soon
  as it is discovered.
- **Move, do not rewrite.** A moved statement keeps its conditions and their order.
- **Contract names stay.** The `Checkpoint` and `Batch` fields `codexFork`, `claudeCallOrigins`,
  `reconcileCodexForkFrom` and `backfillClaudeOriginsFrom` keep their names. `scan/scan-recovery.ts`
  continues to read these contract fields.
- **New provider code is class members.** `providers/` is a cleaned directory. The top-level functions
  that are in the `pending` files stay until step 4.

The commits, each with all checks green and the output comparison of step 0:

1. The constraints: this section, [scan.tsp](local-collector/scan.tsp) and the two dependency rules.
2. The port and rows 2 to 8. `CodexHistory` and `ClaudeHistory` implement `ScanProvider`. The scanner
   still builds its two providers, and it knows them only through the port.
3. Row 1. `LocalCollector` takes one options object. `LocalProviders.fromConfig` gives objects that
   implement both ports, and the command builds the reader and the scanner from that list. The tests
   build a collector from a configuration with one fixture helper. The type `ScanProgress` moves to
   `scan/`.
4. Row 9. Each provider declares its own source type.
5. Row 10. Each parser format has the provider rules for its checkpoints.

The rows move before the options object. If the providers were injected first, the engine would need
temporary provider branches and type casts for rows 2 to 8.

Size: large. This step has the most risk. It changes `local-collector.ts`, `source-presence.ts`,
`source-sightings.ts` and `transcript-cursor.ts`, about 950 lines. The scan scenarios, the 34 test
files in `test/integration/scan` and the two in `test/integration/watch` cover it.

### Step 4. Functions to classes

Four bounded tasks. Each worker owns a set of files and each caller of what it renames.

| Task | Files | Functions | Extra checks |
| --- | --- | ---: | --- |
| 4a | `providers/codex/` | 51 | `bun run check:collector-structure`, after the Codex names leave `pending` |
| 4b | `providers/claude/` | 17 | `bun run check:collector-structure`, after the Claude Code names leave `pending` |
| 4c | `scan/`, `watch/`, `transcript/`, `commands/`, `cli.ts`, shared classes | 44 | |
| 4d | `storage/`, and three API files that import the renamed helpers | 150 | `bun run check:collector-api`, `bun run check:collector-postgres` |

These counts are the 262 functions that remain after step 1. Step 3 removed two functions of `scan/`, so
task 4c has 42.

Tasks 4a, 4b and 4d touch separate files and can run at the same time. Task 4c follows 4a and 4b,
because it renames helpers that they call. Task 4d is the largest. The API replays each stored write
through `InMemoryCollectorStorage`
([postgres-collector-storage.ts:1](../../apps/api/src/storage/postgres-collector-storage.ts#L1)), so
the PostgreSQL suites must pass.

### Step 5. Finish

1. Tests import public classes through the package exports and internal classes through `#src/…`.
   Remove the relative `../src` imports. Fix the Knip resolution of `#src/…`.
2. Remove the four test-only methods from production code (decision 2).
3. Apply the ESLint rule to all of `apps/collector/src`.
4. Update the README, the specification links and both component manifests.

## Risks

| Risk | Control |
| --- | --- |
| A cleanup changes a stored ID. The two parsers build a text block with different key orders (`claude-chat.ts:80`, `codex-chat.ts:438`). The block goes into the hash of a fallback message ID. If one shared type changes a key order, an anonymous message gets a different ID. A replay or a second copy of the chat then stores that message two times. | Step 0, items 1 and 2. Keep `CodexVisibleText` and `ClaudeVisibleText` separate. |
| A cleanup changes the key order of `snapshot()`. A checkpoint from before the change then looks different, and a lost reply cannot be confirmed. | Step 0, item 1. |
| A helper moves back into a class and the file passes 500 lines. | Finding 6. Run `bun run habit-hooks --branch main` in each step. |
| A storage change breaks the API. | Step 4d runs the API and PostgreSQL suites. The storage contract files do not change. |
| A logger call moves out of `cli.ts` and the log prefix changes. | All logger calls stay in `cli.ts`. The CLI tests match `cli.ts` in the prefix. |
| Two workers edit the same file. | The task table in step 4 gives each worker separate files. |

## Left alone on purpose

- The parser logic, the stored contract, the checkpoint format and the HTTP wire format.
- The names `LocalLLMHistory`, `LocalCollector` and `InMemoryCollectorStorage`.
- The Codex and Claude parsers stay separate. They share little. A shared base class would bring back
  the inheritance problem of finding 1.
- Three Codex classes read the same turn events for three different purposes. They stay separate.

## Decisions for the owner

1. **Provider class names.** The plan uses `CodexHistory` and `ClaudeHistory`. The request said
   "Anthropic". The configuration key (`claudePath`), the stored `harness` value and the specification
   all say `claude`. Recommendation: keep `Claude`.
2. **Test-only methods.** `readRollouts` and `readTranscripts` are in [scan.tsp](local-collector/scan.tsp),
   but only tests call them. `ClaudeChat.decode` and `CodexChat.decode` are the same. Recommendation:
   remove them from the contract and move them to test fixtures.
3. **Scope of `storage/`.** It holds 150 of the 265 functions and the API runs it. Recommendation:
   include it as step 4d. The alternative is to stop after step 4c and plan storage separately.
4. **Two shared leaf modules.** History, scan and storage all need `RecordedInstant` and
   `ClaudeTranscriptCopy`. Recommendation: move both to `packages/shared`, beside `recorded-path.ts`,
   and move `ajv` and `ajv-formats` to its dependencies. `storage/` is then self-contained. The
   alternative keeps both in `storage/` and lets `history/` import one storage file.
5. **Enforcement.** Recommendation: add `check:collector-structure` to the PR workflow, so that a new
   top-level function fails the check.
