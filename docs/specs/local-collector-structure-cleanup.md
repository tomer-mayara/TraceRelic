# Local collector structure cleanup

A developer opens `apps/collector/src/` and finds one class that reads history between two dates. That
class receives its providers. One directory for each provider holds all the code that knows that
provider's files and records. Each rule belongs to a class. The CLI output, the exit codes, the stored
sessions and the checkpoints stay the same. [Current specification](local-collector.md)

Affected components: `apps/collector` (all of `src/` and its tests), `packages/shared` (two leaf
modules) and `apps/api` (only its imports of the names that change).
[Step 6](#step-6-follow-ups-outside-the-collector) has its own list.

## Status

| Step | Result | State |
| --- | --- | --- |
| 0 | Golden tests pin the saved state and the IDs of each parser as exact text | Done, [PR 28](https://github.com/tomer-mayara/TraceRelic/pull/28) |
| 1 | The history reader receives its providers | Done, [PR 28](https://github.com/tomer-mayara/TraceRelic/pull/28) |
| 2 | One directory for each provider and for each layer | Done, [PR 29](https://github.com/tomer-mayara/TraceRelic/pull/29) |
| 3 | The scanner receives its providers through a port | Done, [PR 30](https://github.com/tomer-mayara/TraceRelic/pull/30) |
| 4 | Each function is a member of a class | Done, [PR 31](https://github.com/tomer-mayara/TraceRelic/pull/31) |
| 5 | A test reaches the source in two ways, and six members that only tests read are in test fixtures | Done, [PR 32](https://github.com/tomer-mayara/TraceRelic/pull/32) |
| 6 | Two structure rules also check the API and the shared package, the type check declares two built-ins, and the database fixture removes its volumes | Done, [PR 35](https://github.com/tomer-mayara/TraceRelic/pull/35) |
| 7 | The copies of seven rules call one method each | Done, [PR 36](https://github.com/tomer-mayara/TraceRelic/pull/36) |

The description of each PR has the check results of its step.

| Measure | Before | After step 1 | After step 2 | After step 3 | After step 4 | After step 5 | After step 7 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Top-level functions in `apps/collector/src` | 265 | 262 | 258 | 256 | 0 | 0 | 0 |
| Classes | 57 | 67 | 67 | 70 | 93 | 93 | 94 |
| Node tests | 687 | 778 | 778 | 809 | 809 | 815 | 848 |
| Collector scenarios | 47 | 49 | 49 | 52 | 52 | 52 | 52 |

"Before" is commit `21ab8a9`. Step 2 moved four of the functions to `packages/shared` with two leaf
modules. Step 3 moved two functions into provider classes. After step 4, each function of
`apps/collector/src` and of the two leaf modules is in a class. Step 5 added one golden test, which has
five batches. Step 6 changed none of these numbers. Step 7 added one class and 33 tests.

## Structure

Steps 1 to 4 made this structure. Step 5 did not change it. The change after step 5 added the type
`Fields` to `json-record.ts`. Step 7 added the class `ContractValues` to the storage port and the method
`JsonRecord.isNonemptyString`.

```text
apps/collector/src/
├── cli.ts                     the logger, the standard output and the exit codes
├── commands/
│   ├── collector-command.ts   CollectorCommand: builds the providers, the reader, the scanner and the schedule
│   └── command-arguments.ts   CommandArguments: checks the CLI options
├── config/                    the configuration file, its schema and its loader
├── history/                   the date reader
│   ├── local-llm-history.ts   LocalLLMHistory: readLocalHistory(from, to) over the providers that it receives
│   ├── history-provider.ts    HistoryProvider (port), LocalHistoryEntry
│   └── history-window.ts      HistoryWindow: checks the bounds, tests one timestamp
├── providers/
│   ├── local-providers.ts     LocalProviders.fromConfig(config): the providers of the configured roots
│   ├── codex/                 all code that knows Codex files and records
│   │   ├── codex-history.ts          CodexHistory: implements HistoryProvider and ScanProvider
│   │   ├── codex-scan.ts             CodexScan: one scan pass, with the fork evidence of its latest discovery
│   │   ├── codex-rollout-files.ts, codex-rollout-copies.ts, codex-session-header.ts
│   │   ├── codex-session-parser.ts, codex-chat.ts, codex-visible-text.ts
│   │   ├── codex-usage.ts, codex-usage-report.ts, codex-token-counts.ts
│   │   └── codex-fork-evidence.ts, codex-fork-sources.ts, codex-fork-usage.ts, codex-identity-repair.ts
│   └── claude/                all code that knows Claude Code files and records
│       ├── claude-history.ts         ClaudeHistory: implements HistoryProvider and ScanProvider
│       ├── claude-scan.ts            ClaudeScan: one scan pass
│       ├── claude-transcript-files.ts, claude-session-identity.ts, claude-source-copy.ts
│       ├── claude-session-parser.ts, claude-chat.ts, claude-visible-text.ts
│       └── claude-usage.ts, claude-usage-counts.ts, claude-assistant-record.ts
├── transcript/                provider-neutral file reading
│   ├── captured-transcript-file.ts, transcript-directories.ts
│   ├── jsonl-records.ts       JsonlRecords: complete lines to JSON objects
│   ├── json-record.ts         JsonRecord: the checks on one decoded JSON value. Fields: the type of a JSON object
│   ├── transcript-batches.ts  TranscriptBatches: byte-bounded batches with prefix digests
│   ├── source-discovery.ts    SourceDiscovery: the selection by session and project
│   └── transcript-source.ts   TranscriptSource, RecordBatch, ReadPosition, ScanSelection
├── scan/                      provider-neutral import engine
│   ├── local-collector.ts     LocalCollector: scanOnce, scanForChanges; receives providers and storage
│   ├── scan-provider.ts       ScanProvider and ProviderScan (port)
│   ├── transcript-cursor.ts, parser-state.ts, replay-occurrences.ts, decoded-chat.ts
│   ├── scan-recovery.ts, checkpoint-proof.ts, source-presence.ts, source-sightings.ts
│   └── scan-pending.ts, scan-rejected.ts, scan-progress.ts
├── watch/                     scheduled-scanner.ts, scan-activity.ts
└── storage/                   the API imports only this directory
    ├── collector-storage.ts   the port: contract types, CollectorStorage, error classes
    ├── in-memory-collector-storage.ts, checkpoint-transition.ts, batch-values.ts
    ├── session-messages.ts, session-metadata.ts, session-usage.ts
    ├── source-inventory.ts, source-usage-diagnostics.ts
    ├── http/                  HttpCollectorStorage, CollectorWireContract, PackedBatches
    ├── claude/                usage ledger, call owners, origin reports, advisor iterations
    └── codex/                 call aliases, call owners, source identity, usage windows, usage intervals
```

`config/`, `history/`, `providers/` and `transcript/` each have an `index.ts`. It is the package export of
that directory. `providers/index.ts` and `providers/local-providers.ts` are the only files that name both
providers. Two leaf modules that history, scan and storage all use are in `packages/shared/src`:
`recorded-instant.ts` and `claude-transcript-copy.ts`.

### The date reader

```ts
const providers = LocalProviders.fromConfig(config);   // CodexHistory, and ClaudeHistory if configured
const entries = await new LocalLLMHistory(providers).readLocalHistory(fromDate, toDate);
```

`LocalLLMHistory` checks the window one time and reads the providers together. It returns their records
in the sequence of the providers. A provider receives its root path, not the configuration. If the
configuration has no `claudePath`, there is no Claude Code provider. The port is
[`HistoryProvider`](../../apps/collector/src/history/history-provider.ts). It has one member,
`readHistory(window)`. The contract is [history.tsp](local-collector/history.tsp).

### The scanner

`LocalCollector` receives the same provider objects through a second port,
[`ScanProvider`](../../apps/collector/src/scan/scan-provider.ts). The contract is
[scan.tsp](local-collector/scan.tsp).

```ts
new LocalCollector({ providers, storage, installationId, onRejection, onMissing, progress });
```

A provider opens one `ProviderScan` for each scan pass. The pass keeps the state of that pass. Each
provider decision that the engine made before step 3 is behind the port. The generic algorithm stays in
the engine.

| # | Provider decision | Port member | Codex | Claude Code |
| --- | --- | --- | --- | --- |
| 1 | Construct the providers | `LocalCollectorOptions.providers` | `LocalProviders.fromConfig` | `LocalProviders.fromConfig`, only when `claudePath !== undefined` |
| 2 | Fork evidence and parser selection | `ProviderScan.parserFor`, and the state of the pass | `CodexScan` keeps the `CodexForkSources` of its latest discovery | `ClaudeSessionParser.forSource` |
| 3 | File grouping | `ProviderScan.discoverFiles` | One source for each group, as soon as it is discovered | All the selected sessions of one file together |
| 4 | Logical file name | `ProviderScan.logicalName`, optional | The rollout name without `.zst` | Absent |
| 5 | Stream ID, path and location | `ProviderScan.locate` | Path: the logical name. Root-based stream ID: the JSON array of the root and the path | Path: relative to the root. Root-based stream ID: the absolute file |
| 6 | Identity repair | `ProviderScan.repairIdentities`, optional | `CodexIdentityRepair` | Absent |
| 7 | Earlier copies of an absent file | `ProviderScan.earlierCopies`, optional | Absent | `ClaudeEarlierCopies`, `ClaudeSourceCopy` |
| 8 | A batch of an earlier copy | `ParserFormat.prepareBatch`, optional | Absent | The format of an earlier copy |
| 9 | Provider fields of a source, and the record types that get a prefix digest | The source type of each provider, and `SelectedFile.isConversation` | `CodexRolloutSource`; `response_item` and `event_msg` | `ClaudeTranscriptSource`; `user` and `assistant` |
| 10 | Provider fields of a checkpoint, and the correction of accepted usage | `ParserFormat.checkpointFields` and `ParserFormat.correction` | `codexFork` and `reconcileCodexForkFrom` | `claudeCallOrigins` and `backfillClaudeOriginsFrom` |

The engine applies one generic rule for the stream ID. With an installation ID, the stream ID is the
path of the location. Without one, it is the root-based stream ID of the provider.

## Rules that keep the structure

**Dependency rules.** They are in [.dependency-cruiser.collector.json](../../.dependency-cruiser.collector.json).
`bun run check:collector-deps` checks them.

| Rule | From | Forbidden import |
| --- | --- | --- |
| `history-reads-through-the-provider-port` | `history/` | Each other collector directory |
| `transcript-layer-is-provider-neutral` | `transcript/` | `providers/`, `scan/`, `watch/`, `storage/`, `config/`, `commands/` |
| `readers-and-scanner-read-files-through-transcript` | `history/`, `providers/`, `scan/`, `watch/` | `node:fs` |
| `providers-do-not-know-each-other` | `providers/codex/`, `providers/claude/` | Each provider file outside its own directory: the other provider, `providers/index.ts` and `providers/local-providers.ts` |
| `providers-receive-their-paths` | `providers/codex/`, `providers/claude/` | `config/` |
| `scan-engine-is-provider-neutral` | `scan/`, `watch/` | `providers/` |
| `outside-providers-use-the-provider-index` | Each source file outside `providers/` | `providers/codex/`, `providers/claude/` |
| `scanner-uses-only-the-storage-port` | `scan/`, `watch/`, `providers/` | Each `storage/` file other than the port, also through another file |
| `storage-is-self-contained` | `storage/` | Each other collector directory |

The rules for the API, the HTTP client, the schedule and the storage port were there before the cleanup.
They have the same meaning with the new paths. `schedule-runs-the-scan-through-its-handler` also forbids
`providers/` and `transcript/`, because the readers went there from `history/`. A provider imports the
storage port: the scan port names its types, and provider classes call `StreamKeys`,
`LegacyScannerSource` and `ContractValues`. Thus `local-history-is-independent-of-storage` applies to
`history/` and `transcript/` only.

**Structure rule.** [collector-structure.eslint.mjs](../../.habit-hooks/collector-structure.eslint.mjs)
has three selectors. `bun run check:collector-structure` checks them, and the
[PR workflow](../../.github/workflows/collector.yml) runs that script. Habit Hooks applies the same rule
through its own configuration.

| Selector | Files | Forbidden |
| --- | --- | --- |
| A function outside a class | `apps/collector/src` and the two shared leaf modules | A declaration, a function expression or an arrow function that is not in a class body |
| `this` in a static method | The same files, `apps/api/src` and all of `packages/shared/src` | Each `this` in a static method or in a static `get` or `set` accessor, also in a function that is in that method |
| A relative import of the source | The `test` directory of `apps/collector`, of `apps/api` and of `packages/shared` | An import, a re-export, a dynamic import or an import type whose module is `../src` |

The second selector looks only at methods and at `get` and `set` accessors. It does not look at a static
field, at an `accessor` field or at a static block. No file of this rule has a `this` there. The first
selector does not apply to `apps/api/src`, which has 21 functions outside a class body in five files. It
also does not apply to the other files of `packages/shared/src`: `recorded-path.ts` has two such
functions. [Decision 7](#decisions) keeps them.

**Test imports.** `apps/collector/package.json` has ten named exports, such as `./storage` and `./scan`.
A test imports a name that one of them has through the package: `@tracerelic/collector/…`. A test
imports each other name through `#src/…`. `apps/api` has the same `#src/…` map, and the tests of
`packages/shared` import the package. The third selector checks only that no test imports `../src`. It
does not see other forms of such an import. Three examples are `import x = require(…)`, a dynamic import
whose module is a template, and a path that starts with `./../`. No test has one of them.

## Constraint decisions

These decisions apply to all the steps. Step 4, the change after step 5, step 6 and step 7 add to them
in their own sections.

| Constraint | Decision | Check |
| --- | --- | --- |
| Behavior | No step changes what a user of the CLI sees. A TypeScript caller can do two new things, and each one has scenarios: a reader for the providers that it receives ([history-providers.feature](../../apps/collector/test/interface/history/history-providers.feature), step 1) and a scanner for the providers that it receives ([scan-providers.feature](../../apps/collector/test/acceptance/scan/scan-providers.feature), step 3). | `bun run test`, `check:collector-history`, `check:collector-scan`, `check:collector-storage`, `check:collector-api`, `check:collector-postgres` |
| Observability | Out of scope. No signal is added or changed. Each logger call stays in `cli.ts`, because the log prefix shows the file and the line of the call. | The CLI tests match the file name in that prefix |
| Architecture | The rules in [Rules that keep the structure](#rules-that-keep-the-structure). | `check:collector-deps`, `check:collector-structure` |
| Interface | [history.tsp](local-collector/history.tsp) has `HistoryWindow`, `HistoryProvider` and the reader that receives its providers. [scan.tsp](local-collector/scan.tsp) has the scan port, the source type of each provider and `LocalCollectorOptions`. An interface of a contract gives each member of a TypeScript object as one operation. The storage and HTTP contracts do not change. | `schema:collector-history`, `schema:collector-scan`, `schema:collector-storage`. The compiler does not compare an interface of a contract with the TypeScript port, so a change to a port includes its contract. |

## How a step shows that behavior did not change

| Check | What it does |
| --- | --- |
| Golden tests | Seven `*-parser-*golden.test.ts` files in [test/unit/providers](../../apps/collector/test/unit/providers) pin the saved state, the message IDs and the usage IDs of each parser as exact text. They passed on `main` before the first production change. No step changed a golden text. |
| Output comparison | Run `scan --once` and `history` on a read-only copy of local transcripts, before the change and after it. The standard output, the standard error and the exit code must be the same bytes. Run the commands two times before the change, to confirm that the output is stable. |
| Trace comparison | The CLI output does not show the sequence of the work. Record each `open`, `stat` and `readdir` of a transcript path, and each storage call with a digest of its arguments and of its result. The traces must be identical. |
| Rule probe | Add one forbidden line for each changed rule. Each line must make its check fail. |
| Independent review | A reviewer that did not write the change compares the old statements with the new statements. |

| Change | Output comparison | Trace comparison |
| --- | --- | --- |
| Step 1 | 5 commands, identical | Not run |
| Step 2 | 7 commands, identical. A script also showed that only import lines changed. | Not run |
| Step 3, after each code commit | 13 commands, identical | 12 scenarios, identical |
| Steps 1 to 3 together: `main` and the commit of step 3 | 13 commands, identical | 12 scenarios, identical |
| Step 4, after each code commit | 13 commands, identical | 12 scenarios, identical |
| Step 5, after each change of the production source | 13 commands, identical | 12 scenarios, identical |
| The change after step 5 | Not run. [Two comparisons of the code](#after-step-5-one-declaration-of-fields) replace it. | Not run |
| Step 6, after its last code commit | 13 commands, identical | 12 scenarios, identical |
| Step 7, after its last code commit | 13 commands, identical | 12 scenarios, identical |

The 13 commands are: a full scan with an installation ID and one without; a full history window and a
window with fractional seconds; a scan with `--session` and one with `--project`; a Codex fork child
alone, with its parent, and with a parent that is not in the sample; a scan with no Claude Code root.
Ten run the source on Bun, and three run the compiled files on Node.js.

The 12 scenarios are: two scans with root-based stream IDs, and two with an installation ID; a fork
child alone, then with its parent; a project selection, then a session selection; checkpoints of an
earlier collector that have no `codexFork` and no `claudeCallOrigins`; checkpoints that have no evidence
version; a scanner for Codex alone, then for both providers; earlier copies of Claude Code transcripts
when the current file is absent; a Codex fork child that gets a new inode during the scan; one collector
that scans three times, and one that scans while files go away and return.

The sample is private history. It is not in the repository. Nothing from it goes into a commit, a PR or
a request to a service. A report gives only "identical" or "different" and the number of commands or
scenarios.

## Steps

Each step is one PR and leaves all checks green. A step records its constraints in its first commit,
before the code changes.

### Steps 0 and 1. Safety net, and the history reader receives its providers

Done in PR 28.

- **Step 0.** The golden tests. A swap of two keys in one `snapshot()` failed 16 of them and no other
  test.
- **Step 1.** `LocalLLMHistory` was an abstract class with one subclass for each provider. It is now a
  concrete class that receives a list of `HistoryProvider`. `CodexHistory` and `ClaudeHistory` implement
  the port and receive a root path. The three jobs of the old base class are separate classes:
  `HistoryWindow`, `SourceDiscovery`, and `JsonlRecords` with `TranscriptBatches`. Four checks for an
  absent `claudePath` went away, because a Claude Code provider exists only when the path is configured.

### Step 2. One directory for each provider and for each layer

Done in PR 29. Moves and import edits only: 37 source files and 33 test files have a new path or a new
name. The parsers went to `providers/`, the schedule to `watch/`, and the storage files to `http/`,
`claude/` and `codex/`. The two shared leaf modules went to `packages/shared`, so that `storage/` imports
no other collector directory. A test file moved when its subject moved.

### Step 3. The scanner receives its providers

Done in PR 30. The table in [The scanner](#the-scanner) gives the port member for each provider
decision. No row stayed in the engine. `scan/` and `watch/` import nothing from `providers/`, and `scan/`
does not test the name of a harness.

Two differences from the code before step 3 are known. No input of a real scan reaches them.

- `CodexScan.parserFor` throws an `Error` when no discovery ran before it. The old closure threw a
  `TypeError` there. The scanner selects a parser only for a source that a discovery gave.
- A parser state that no collector can write can name a line after its checkpoint as the first copy of
  a later message. If that line is a Codex record of type `user`, the old scanner added a prefix digest
  for that line to `messageOrigins`, and the new scanner does not. A collector writes only positions at
  or before its checkpoint, and it names only an `event_msg` record as such a first copy.

### Changes of steps 1 to 3 for a TypeScript caller

- **The reader.** `new LocalLLMHistoryCodex(config)` is now
  `new LocalLLMHistory([new CodexHistory(config.codexPath)])`, or
  `new LocalLLMHistory(LocalProviders.fromConfig(config))` for the configured providers.
- **The scanner.** `new LocalCollector(config, storage, ...)` is now
  `new LocalCollector({ providers, storage, ... })`. A scanner for one provider is possible.
- **Package exports.** `./providers` and `./transcript` are new. The provider classes moved from
  `./history` to `./providers`. `TranscriptChangedError` and the generic transcript types moved from
  `./history` to `./transcript`. `./scan` also exports the port types. `ClaudeSubagent` is an export of
  `./providers`. `codexRolloutName` has no public replacement.
- **`@tracerelic/shared`** exports six more names: `isRecordedTimestamp`, `isHistoryTimestamp`,
  `recordedInstant`, `compareRecordedInstants`, `claudeCopyFallbackFields` and `claudeCopyStem`.
- **Sources.** The source types are `CodexRolloutSource` and `ClaudeTranscriptSource`. A discovered Codex
  source has no `previousCopy`. `readBatches` gives a `recordPrefixDigest` only to the conversation
  records of its provider. Before, it gave one to a record of each of the four types for each provider.
- **Parser formats.** `ParserFormat` has `checkpointFields` in place of `codexFork` and
  `claudeCallOrigins`.

### Step 4. Functions to classes

Done in PR 31. At the start of this step, 260 top-level functions remained: 256 in
`apps/collector/src` and 4 in the two shared leaf modules. Each function became a member of the class
that owns its rule. No logic changed. The object `systemClock` in `watch/scheduled-scanner.ts` held two
more functions that were not in a class. They are the class `SystemClock` now.

| Constraint | Decision and check |
| --- | --- |
| Behavior | No change. No scenario is new, because a caller can do nothing new. The scenarios, the tests and the golden texts are the specification. After each code commit, run the output comparison and the trace comparison. |
| Observability | Out of scope. Each logger call stays in `cli.ts`, on the same line as before. One difference is known, and the owner accepted it: in the compiled `dist/cli.js`, each call is one line lower. |
| Architecture | The structure rule applies to all of `apps/collector/src` and to the two shared leaf modules. During the step, a `pending` list named each file that was not clean, and each task removed its names. The list is gone. The dependency rules did not change. `storage/` imports no other collector directory, so `BatchValues` is in `storage/` and `JsonRecord` is in `transcript/`. |
| Interface | No TypeSpec change. No `.tsp` file declares one of the 260 functions as an operation. The TypeScript names that a caller imports change. |

Many functions had a caller in a different directory. Thus the step started with one task for the
shared rules, the border task. After it, no remaining function had a caller in another task area, and
the other four tasks ran at the same time in separate checkouts.

| Task | Files | Functions |
| --- | --- | ---: |
| Border | The shared classes, each function that has a caller in another task area, and the API files that import a changed name | 43 |
| 4a | `providers/codex/` | 46 |
| 4b | `providers/claude/` | 12 |
| 4c | `cli.ts`, `commands/`, `scan/`, `transcript/`, `watch/` | 26 |
| 4d | `storage/` | 133 |

The API replays each stored write through `InMemoryCollectorStorage`, so the border task and task 4d
had to pass `check:collector-api` and `check:collector-postgres`.

The rules for each conversion:

- **No logic change.** The statements, the conditions and their sequence stay. A conversion changes only
  where a helper is and how a caller names it.
- **Stored and hashed data keeps its bytes.** A parser state, an ID, a batch, a checkpoint and a wire
  record stay plain objects with the same key order. No stored record becomes an instance of a class.
- **Two copies of a rule merge only if they give the same result for each input.** If they differ in
  one case, both stay.
- **A helper that needs no instance is a static method.** A caller names it through its class, not
  through `this`. Thus a static method that goes to `map`, `filter` or `sort` as a value needs no
  receiver.
- **A type predicate stays a type predicate**, and a function that returns `never` keeps that type.
- **A test changes only the name through which it gets a helper.** No assertion goes away, and no golden
  text changes.

The class of each function:

| Task | Now | Functions | Becomes |
| --- | --- | ---: | --- |
| Border | `packages/shared/src/recorded-instant.ts` | 3 | `RecordedInstant`: `isTimestamp`, `parse`, `compare` |
| Border | `packages/shared/src/claude-transcript-copy.ts` | 1 | `ClaudeTranscriptCopy`: `stem`, and the list `fallbackFields` |
| Border | The plain-object, string and count checks of the parsers (9 copies) | 9 | `JsonRecord` in `transcript/json-record.ts`: `is`, `object`, `identifier`, `isCount` |
| Border | `scan/parser-state.ts` | 4 | `ParserState`: `digest`, `record`, `string`, `invalid` |
| Border | `scan/scan-recovery.ts` | 5 | `CheckpointProof` in `scan/checkpoint-proof.ts`: `prefixes`, `verifiedBy`, `capture`, `same`. `readStorage` becomes `ScanRecovery.read`. |
| Border | The stream key and session key text (4 copies in `scan/`, `watch/` and `storage/`) | 4 | `StreamKeys` in the port file: `session`, `stream`, `sourceId` |
| Border | `transcript/transcript-directories.ts` | 2 | `TranscriptDirectories`: `listDirectory`, and the private `missing` |
| Border | `storage/collector-storage.ts` | 7 | `LegacyScannerSource`: `location`, `stream`, `line`, `needsHistoryVerification`, `historyDiagnostic`, and the private `position`. `SourceScopes.matches`. |
| Border | `storage/http/packed-batch.ts` | 8 | `PackedBatches`: `pack`, `unpack`, `digest`, `stateBytes`, `fitsWireRecords`, `decodeBase64`, and two private methods |
| 4a | `codex-chat.ts` | 13 | `CodexVisibleText` in `codex-visible-text.ts`: `role`, `completedRole`, `completedBlocks`, `blocks`, and three private methods. The other six become private static methods of `CodexChat`. |
| 4a | `codex-token-counts.ts` | 7 | `CodexTokenCounts`: `fromProvider`, `restore`, `sameTotals`, `mergeRepeated`, `minus`, `partition`, and the private `counts` |
| 4a | `codex-usage-report.ts` | 14 | `CodexCallContext`: `after`, and the private `advance`. `CodexUsageReport`: `read`, `initialHistory`, `recorded`, and nine private methods. |
| 4a | `codex-usage.ts`, `codex-fork-evidence.ts`, `codex-fork-sources.ts` | 12 | Static methods of `CodexUsage`, `ForkCapture`, `CodexForkEvidence` and `CodexForkSources` |
| 4b | `claude-chat.ts` | 2 | `ClaudeVisibleText` in `claude-visible-text.ts`: `blocks`, and the private `injected` |
| 4b | `claude-usage.ts` | 4 | `ClaudeAssistantRecord` in `claude-assistant-record.ts`: `message`. The other three become private static methods of `ClaudeUsage`. |
| 4b | `claude-usage-counts.ts`, `claude-source-copy.ts` | 6 | Private static methods of `ClaudeUsageCounts`. Members of `ClaudeEarlierCopies`. |
| 4c | `cli.ts` | 2 | `CollectorCli`: `run`, and the private `configuredStorage` |
| 4c | `commands/collector-command.ts` | 4 | `CommandArguments` in `commands/command-arguments.ts`: `instant`, `projectPath`, `watchInterval`. `untilShutdown` becomes a private static method of `CollectorCommand`. |
| 4c | `scan/replay-occurrences.ts` | 5 | `ReplayOccurrences`: `restore`, `plan`, `count`, `reconcile`, and the private `fallbackId` |
| 4c | The other files of `scan/`, `transcript/` and `watch/` | 15 | Private static methods of the class in the same file. `ScanRejectedError.batch` and `ScheduledScanner.checkedIntervalMs` are public. |
| 4d | `batch-values.ts` | 14 | `BatchValues` |
| 4d | `checkpoint-transition.ts` | 18 | `CheckpointTransition`: `new CheckpointTransition(batch, current).failure()` |
| 4d | `session-usage.ts` | 13 | `SessionUsage`: `apply`, and twelve private static methods |
| 4d | `codex/usage-windows.ts` | 26 | `UsageIntervals` in `codex/usage-intervals.ts` for the fifteen interval rules. `UsageWindows.isWindow`. The other ten become private static methods of `UsageWindows`. |
| 4d | `codex/observed-counter-spans.ts`, `codex/codex-source-identity.ts` | 16 | `ObservedCounterSpans`: `epochsWithSharedObservations`, `shared`. `CodexSourceIdentity.correction`. The others are private. |
| 4d | The other files of `storage/` | 46 | Private static methods of the class in the same file. `SessionMetadata.isValid` and `CodexCallAliases.valid` are public. |

Four names need a reason:

- **`PackedBatches`, not `PackedBatch`.** `PackedBatch` is the wire record of the contract, and it keeps
  its name. A class and an interface with one name are an unsafe declaration merge.
- **The type `ReplayBounds`.** The class has the name `ReplayOccurrences`. The record that it reads and
  writes had the same name, and that type is now `ReplayBounds`. The parser state keeps the key
  `replayOccurrences`.
- **`RecordedInstant.compare` is static.** A parsed instant stays a plain object, as the history window
  and the session metadata hold it.
- **`ClaudeAssistantRecord` has the rule of `claude-usage.ts` only.** `ClaudeChat.read` applies its rule
  to user records too, so the two rules do not give the same result for each input.

The results:

- **The conversion.** The 260 functions are 254 methods, because twelve copies of a rule became six
  methods of `JsonRecord` and `StreamKeys`. Of the 254 methods, 165 are private and 8 are instance
  methods. The step made 23 classes in `apps/collector/src` and 2 classes in `packages/shared`. It added
  no test and no scenario.
- **Statement comparison.** A script read each function before the step and its method after the step.
  It replaced each old name with the new name and compared the tokens. Of the 260 bodies, 247 have the
  same tokens. The other 13 are different by design: six copies that `JsonRecord` replaced had a
  different form of the same rule, the six decisions of `CheckpointTransition` start with
  `const { batch, current } = this;`, and `ClaudeEarlierCopies.assess` calls `this.unreadable`.
- **Review.** Five independent reviews, one for each task, compared the old statements with the new
  statements. They found no behavior difference.

Changes of step 4 for a TypeScript caller. No `.tsp` file changed. The exported functions are members of
exported classes:

- **`@tracerelic/shared`.** `RecordedInstant` (`isTimestamp`, `parse`, `compare`) replaces
  `isHistoryTimestamp`, `recordedInstant` and `compareRecordedInstants`. `ClaudeTranscriptCopy` (`stem`,
  `fallbackFields`) replaces `claudeCopyStem` and `claudeCopyFallbackFields`.
- **`@tracerelic/collector/storage`.** `LegacyScannerSource` (`location`, `stream`, `line`,
  `needsHistoryVerification`, `historyDiagnostic`) and `SourceScopes.matches` replace six functions.
  `StreamKeys` is new.
- **`@tracerelic/collector/wire-contract`.** `PackedBatches` (`pack`, `unpack`, `digest`, `stateBytes`,
  `fitsWireRecords`, `decodeBase64`) replaces six functions.
- **`cli.ts`.** `CollectorCli.run` replaces `runCollectorCli`.

### Step 5. Finish

Done in PR 32. No scenario is new, and no golden text that was there changed.

- **Test imports.** A test reaches the source in the two forms that
  [Rules that keep the structure](#rules-that-keep-the-structure) gives. Before, 63 type imports named
  `../src`.
- **Members that only tests read.** Six members are in test fixtures now, with the same statements:
  `CodexHistory.readRollouts`, `ClaudeHistory.readTranscripts`, `TranscriptBatches.snapshot`,
  `ClaudeChat.decode`, `CodexChat.decode` and `UsageWindows.mayCover`. The source field `currentFilePath`
  is gone, because no production code read it.
- **Test file names.** `local-llm-history-codex.test.ts`, `local-llm-history-claude.test.ts` and
  `transcript-replay.test.ts` have the name of their subject. The nine tests of
  `source-presence.test.ts` are in `captured-transcript-file.test.ts`, `transcript-directories.test.ts`
  and `claude-transcripts.test.ts`. The moves changed no test name and no test body.
- **A golden test with the lookahead.** One parser prepares the lookahead and then reads each batch of
  the main Codex fixture. The test pins the parser. It does not go through `TranscriptCursor.decode`:
  one integration test, in `resume.test.ts`, fails when the cursor does not prepare the lookahead.
- **No `this` in a static method.** `CodexSessionParser.forFork`, `ClaudeReportEvidence.select` and
  `ClaudeUsageLedger.merge` name their class.

Changes of step 5 for a TypeScript caller:

- **`@tracerelic/collector/providers`.** `CodexHistory.readRollouts`, `ClaudeHistory.readTranscripts` and
  the types `CodexRollout` and `ClaudeTranscript` are gone. A caller reads the batches of a discovered
  source. `ClaudeTranscriptSource` has no `currentFilePath`.
- **`@tracerelic/collector/transcript`.** The type `Transcript` is gone.
- **`@tracerelic/collector/scan`.** `EarlierCopies`, `EarlierCopy`, `SourceCopy` and `CopyAssessment` are
  new exports, because `ProviderScan.earlierCopies` names them.
- **[scan.tsp](local-collector/scan.tsp).** The two readers, their three models and the field
  `currentFilePath` are gone.

### After step 5. One declaration of `Fields`

`Fields` is the type of one decoded JSON object. Six provider files and five test fixtures each
declared this type with the name `Fields`, and one of the fixtures declared it without `Readonly`. The
name now has one declaration, an export of
[json-record.ts](../../apps/collector/src/transcript/json-record.ts). `JsonRecord.object` gives this
type for a JSON object. `Row` in `test/fixtures/claude-chat-fixture.ts` is the same record type without
`Readonly`, and it stays. The change is in types and in import lines only.

| Constraint | Decision and check |
| --- | --- |
| Behavior | No change. The compiler removes each type declaration and each type import. Two comparisons of the commit before the change with the commit after it show this. Each compiled `.js` file must have the same bytes. For the source that Bun runs, Bun's transpiler must give the same code for each changed file. Then run `bun run test`. |
| Observability | Out of scope. No signal is added or changed, and `cli.ts` stays as it is. |
| Architecture | The dependency rules and the structure rule do not change. Before the change, twelve provider files imported `JsonRecord` from `json-record.ts`. Thus the dependency of `providers/` on that file is not new. `check:collector-deps`, `check:collector-structure` |
| Interface | No change. No named package export and no `.tsp` file has `Fields`. `bun run typecheck` checks each import. |

### Step 6. Follow-ups outside the collector

Done in PR 35. The owner decided the three points of this step after step 5. A user of the CLI or of the
API sees no change. Affected components: `apps/api`, `packages/shared`, the root `tsconfig.json` and the
structure rule.

- **Two rules reach further** ([decision 7](#decisions)). The rule against `this` in a static method
  also checks `apps/api/src` and all of `packages/shared/src`. It found one method there,
  `ConsoleLogger.waitForErrorEvent`, which now names its class. The rule against a relative import of the
  source also checks the tests of `apps/api` and of `packages/shared`. It found four type imports in
  three fixtures of `apps/api/test`, which now use `#src/…`. Knip cannot follow such an import, so it
  reported the type `CollectorWrite` as an export that nothing uses. The type is not an export now, and
  two fixtures derive it from `CollectorTransaction["save"]`.
- **The type check declares two built-ins that the code uses.** `Array.fromAsync` and
  `Promise.withResolvers` are not in the library of `target: ES2022`. The type check passed only because
  one test fixture of `packages/shared` imports `bun`, and the types of Bun declare both. A type check of
  the collector alone failed. The root `tsconfig.json` now names the library of each one:
  `"lib": ["ES2022", "ES2024.Promise", "ESNext.Array", "DOM"]`. `DOM` was in the default library, and one
  test fixture uses it. A third built-in, `Error.isError`, keeps the local type that `logger.ts` gives
  it. This step does not change that file.
- **The database fixture removes its volumes.** `disposable-postgres.ts` removed each container with
  `docker rm --force`. Each container then left one unused Docker volume. The command now has
  `--volumes`.

| Constraint | Decision | Check |
| --- | --- | --- |
| Behavior | No scenario is new, because no caller can do a new thing. The one call of `waitForErrorEvent` names `ConsoleLogger`, so `this` was that class. The other changes are types and type imports, one option of the type check and one flag of a test fixture. One type of the API source is not an export now. | `bun run test`, `check:shared-logging`, `check:collector-api`, `check:collector-postgres`. A comparison of the compiled `.js` files of the production source: only three expressions in `console-logger.js` can be different. The output comparison and the trace comparison. |
| Observability | Out of scope. The logger writes the same lines. | The logging scenarios of `check:shared-logging` |
| Architecture | The two wider selectors in [Rules that keep the structure](#rules-that-keep-the-structure). The dependency rules do not change. | `check:collector-structure`, with a rule probe for each new place |
| Interface | Out of scope. No contract changes. | The three `schema:collector-*` scripts |

No CI check keeps the `lib` line and the `--volumes` flag. CI reads the files of all workspaces in one
type check. The types of Bun are there, so that check passes also without the `lib` line. CI gives the
database tests a server through `TRACERELIC_TEST_DATABASE_URL`, so it does not start the containers of
the fixture. The step checked the two points one time: a type check of the collector alone, and a run of
`legacy-journal.test.ts` without that variable.

### Step 7. Rules that methods repeat

Done in PR 36. The owner approved this step on 2026-11-24.

Step 4 and the change after step 5 looked at declarations: functions and types. A rule that a method
writes inline has no declaration, so those scans did not see its copies. Two searches of
`apps/collector/src` at commit `521cb37` list them. The first search gives each regular expression, and
each test, comparison and calculation of 8 tokens or more, that has the same shape in more than one
place. The second search finds, by the structure of the code, each place of four tests: a pattern with
the digest, a count, a positive count and a nonempty string. It does not look for the test for a JSON
object. The searches do not see a rule that is split over two statements, and they do not see the same
rule in a different form. A user of the CLI or of the API sees no change. Affected component:
`apps/collector` (23 source files).

The unit is a test that has a name, such as "a count". A caller that adds a limit to a method, as in
`BatchValues.isCount(x) && x > 0`, uses the method, and the limit is the rule of that caller. Thus the
12 places in 7 files of `storage/` that call `BatchValues.isCount` with a limit are not copies. The step
applies two sentences of the
[coding principles](../engineering-guidelines/coding-principles.md#implementation-and-verification): reuse
existing code, and extract shared logic when a third use expresses the same rule.

| Rule | Places now | After the step |
| --- | --- | --- |
| The text of a SHA-256 digest: 64 hexadecimal digits in lower case | 11 tests in 9 files of `providers/codex/`, `scan/` and `storage/`, with two spellings of the pattern. Two of the tests are private helpers. | `ContractValues.isDigest`. `ContractValues` is a new class in the storage port. |
| The ID of a native Codex call: `call:native:` and a digest | 4 tests in 4 files: 3 files of `storage/`, and `providers/codex/codex-usage.ts` | `ContractValues.isNativeCallId` |
| A nonempty string | 8 inline tests: 7 in 4 files of `providers/`, and 1 in `ParserState.string` | `JsonRecord.isNonemptyString`, a new method. `JsonRecord.identifier` uses it. |
| The first value that is a nonempty string | 4 inline copies in 3 files of `providers/` | `JsonRecord.identifier` |
| A count: a safe integer that is 0 or more | 7 tests in full: 6 in `transcript/transcript-batches.ts`, `scan/parser-state.ts`, `scan/replay-occurrences.ts` and `scan/transcript-cursor.ts`, and 1 in `storage/claude/claude-advisor-iterations.ts` | `JsonRecord.isCount` for the 6, and `BatchValues.isCount` for the 1. A limit, such as `< 1`, stays at its place. |
| A JSON object | 1 test in full in `scan/parser-state.ts` | `JsonRecord.is` |
| The sequence of two token counters | `ObservedCounterSpans.compare`, a private method that has the body of `UsageIntervals.position` in the same directory | `UsageIntervals.position` |

That is 35 places and one private method.

These copies stay:

- **A rule with two places and no method.** Three examples: the test for the error codes `EACCES` and
  `EPERM` in two files of `providers/claude/`, the test for a token-usage record in two files of
  `providers/codex/`, and the name pattern of a rollout file in `source-inventory.ts` and in the storage
  port.
- **Copies in one file.** One example: `codex-token-counts.ts` writes the sum of the cached tokens three
  times.
- **Tests that the layers keep apart.** `transcript/` and `storage/` cannot import each other. Thus
  `JsonRecord` and `BatchValues` each have the test for a count, for a nonempty string and for a JSON
  object.
- **Five tests in full that the step does not change.** The storage port writes the count test one time
  and the test for a JSON object two times. It cannot import `JsonRecord` or `BatchValues`.
  `config/global-config.ts` writes the test for a nonempty string, and `config/` imports no other
  directory of the collector. `captured-transcript-file.ts` writes the count test one time. It imports
  only `node:` modules, and the step adds no import to it.
- **Five patterns that contain the digest and have one place each**, such as the pattern of a text ID.
- **The prefixes of the IDs**, such as `verified:`, `:reset:` and `index:`. A parser writes them and the
  storage reads them. A class for each ID format is a larger change, and it needs its own decision.
- **The digest pattern in the contracts.** `storage.tsp` has it three times and `collector-api/main.tsp`
  has it one time.

| Constraint | Decision | Check |
| --- | --- | --- |
| Behavior | No change. At each place, the method gives the same result as the old test for each value that can reach that place. Three of the digest tests have no test of the type now: their value is a key of an object, which is a string. | Before the change, make the condition of each place wrong on purpose, one place at a time. A test must fail. Where no test fails, add a unit test first. Then: a unit test for each new public member, written first (`ContractValues.isDigest`, `ContractValues.isNativeCallId` and `JsonRecord.isNonemptyString`), the golden tests, the steps of the PR workflow, and the output comparison and the trace comparison before the change and after it. A reviewer that did not write the change names the values that can reach each place. |
| Observability | Out of scope. No signal is added or changed, and `cli.ts` stays as it is. | The CLI tests |
| Architecture | The dependency rules do not change. Two provider files and two scan files get a value import of the storage port, which `scanner-uses-only-the-storage-port` allows. These two scan files and `scan/transcript-cursor.ts` also import `transcript/json-record.ts`. No import makes a cycle. | `check:collector-deps` |
| Interface | The named export `./storage` gets one more class, `ContractValues`. No `.tsp` file changes: `storage.tsp` has the pattern for `PrefixDigest` now. | `bun run build` and the three `schema:collector-*` scripts |

The results:

- **The tests before the change.** The workers made 100 wrong conditions on the code before the change,
  one at a time: 76 at the 35 places, 2 in the body of `ObservedCounterSpans.compare`, and 22 at the call
  sites of the private helpers. No test found 30 of them. Two of the 30 cannot change a result. The other
  28 got a test first: 23 new tests.
- **The change.** The 35 places call the seven methods. Four private helpers went away, because each had
  the body of a method: `CodexUsage.validCallId`, `CheckpointTransition.isPrefixDigest`, the local
  function `isDigest` of `source-inventory.ts` and `ObservedCounterSpans.compare`.
- **The tests after the change.** The workers made 86 wrong conditions at the changed places. The tests
  find 84. The other two cannot change a result.
- **One difference that no input reaches.** `BatchValues.isNativeCodexCall` had no test of the type. It
  now rejects an ID that is not a string and whose text form is a native call ID. Each caller gives it a
  `Usage` that passed `BatchValues.isUsage`, so the ID is a string.
- **Review.** An independent reviewer compared each place before the change and after it, and named the
  values that can reach it. It found no other difference. It ran the 17 test files that pin a place on
  the source of `main`, and each test passes.

## Points that later work must know

- **A restored parser can write different text.** A parser that resumes from a checkpoint does not
  always write the same text as one continuous scan. The golden tests pin five cases as they are. Four
  are a different key order. Three of them have a test with the name "known restore difference, kept as
  it is", and one is in the main Codex golden. The fifth is also in the main Codex golden, and it is
  about one prompt. A parser that reads with no lookahead gives that prompt a text ID. A parser that is
  restored after the batch of that prompt sends the native ID one batch later, as a message that refines
  the accepted one. For a prompt of one block, storage then keeps the text ID and records the native ID
  as an alias. With the lookahead, one parser gives the native ID in the first batch, and the golden
  `mainWithLookahead` pins that text. A scan has the lookahead for each read of two or more batches that
  sends messages. Thus the prompt gets a text ID only when a scan ran before Codex wrote the record that
  has the native ID.

  An analysis after step 5 looked for the effect of the five cases ([decision 9](#decisions)). No case
  makes a duplicate, and no case makes storage reject a batch. The stored messages and usage records
  have the same content, other than the ID of the prompt of the fifth case. Two other effects are
  visible.
  `ScanActivity` compares a hash of the saved state. Thus `watch` can report an `oldestPendingAgeMs` that
  grows for a source that storage holds completely. That needs a request that lands late, or a second
  process of the same installation. And the keys of the `context` of a stored message can come in
  another order. The analysis also found two differences that no golden test pins. One is a sixth key
  order, in the calls of `previousChange`. The analysis found no effect of it. The other is a difference
  of content. The `agent_message` event of an answer can come in a later scan than the answer record.
  The stored answer can then keep its text IDs and miss the request ID that only the event has. A change
  to this behavior is a separate decision.
- **Two block builders, two key orders.** Paginated Codex items build a text block as
  `{ blockIndex, text }`. Legacy Codex records build it as `{ text, blockIndex }`. Claude Code builds
  `{ blockIndex, text }`. The fallback message ID hashes the block, so the builders must stay apart.
- **The logger calls of `cli.ts`.** The log prefix shows the file and the line of a logger call. A change
  that moves a call changes the prefix. The CLI tests accept each line number, so only the output
  comparison shows a call that moved. Step 4 keeps the four calls on their lines in `cli.ts`. In the
  compiled `dist/cli.js` each call is one line lower after step 4, and the owner accepted that.
- **Bun and Node.js read a folder in a different order.** At one commit, the Bun run of the source and
  the Node.js run of the compiled files give different bytes for the sample. An analysis after step 5
  found the cause ([decision 9](#decisions)). `TranscriptDirectories.listDirectory` gives the entries of
  a folder as `readdir` gives them. On macOS, Node.js gives the names in byte order, and Bun gives the
  order of the file system. Thus the two runtimes can read the transcript files in a different sequence.
  The sessions and the entries of the `history` command then come in another order. Stored results can
  also be different. The analysis showed three of them with made-up files. The messages of a session
  that has two or more files can come in another order. The usage rows and the total of such a Codex
  session can be different. `UsageWindows.merge` keeps the counter history of the first file that it
  gets. A Claude Code fork child that storage gets before its parent can get a higher version. No
  contract states the order of the files of a folder, or the order of the sessions of one provider.
  Compare one runtime with itself. A change to this behavior is a separate decision.
- **Build after a change to `packages/shared`.** Bun and Node.js load `@tracerelic/shared` from
  `packages/shared/dist`. Run `bun run build` before `bun run collector`.
- **The function members of the port use method syntax.** `ScanProvider`, `ProviderScan`, `EarlierCopies`
  and `ParserFormat` declare each function as a method, not as a property that holds a function. Thus a
  provider that has its own entry type and source type fits the default type of the port. The compiler
  does not check three things that the code does by construction: the scanner gives a pass only the
  sources that this pass discovered, the scanner keeps each pass with its own presence scan, and `locate`
  gives a location whose root is the root of its provider.
- **Two preconditions that no code checks.** A provider receives its root as an absolute path, and a
  scanner receives at most one provider for each harness. [Decision 6](#decisions) gives the reason.
- **Contract fields in `scan/` are not provider decisions.** `scan/` reads `codexFork`,
  `claudeCallOrigins`, `claudeUsageReports`, `codexCallClaims`, `codexCallAliases` and `currentFileCwd`,
  because they are fields of `Checkpoint`, `Batch` and `SourceLocation` in the storage contract.
- **`providers/` imports `scan/`.** The provider files import the port and the engine classes that a
  parser needs, such as `ParserState` and `DecodedChat`. No rule forbids this direction.
- **Methods that only a pass and the tests call.** `discoverSources`, `confirmedAbsent`, `identitiesAt`
  and `recoveryCandidates` are public on `CodexHistory` and `ClaudeHistory`, and they are not in the
  contract. Each pass class receives its history class as a `Pick` of the methods that it calls.
- **Knip does not follow `#src/…`.** Knip resolves such an import to the compiled file in `dist/`. It
  finds the source of a compiled file only through an `outDir` in a `tsconfig.json` of the same
  workspace. The repository has one `tsconfig.json`, at the root. A second one in an app is the
  TypeScript project of that directory for an editor, and TypeScript 6 then reports errors for the files
  of the other workspaces. Thus Knip reports an export that only a test imports through `#src/…` as not
  used. That agrees with the rule of step 5: a helper that only a test needs belongs in
  `test/fixtures/`. Run Knip after a build. Without one, it reports the `#…` imports as not resolved.
  [Decision 8](#decisions) plans one TypeScript project for each workspace.
- **Pairs that look alike and stay two rules.** `StreamKeys.stream` and `StreamKeys.sourceId` give
  different text for a source that has no installation ID. `ForkCapture.later` and the comparison in
  `SessionMetadata.selectBranch` are not `RecordedInstant.compare`. `ClaudeUsage.text` ignores a string
  of spaces, and `JsonRecord.identifier` accepts it. The list of token breakdown fields is in
  `codex-token-counts.ts` and in `usage-intervals.ts`. A provider file and a storage file cannot import
  each other. The storage port could hold one list, but the list has two uses only.
- **Types that two files declare.** Three types have the same meaning in two files each, and they stay
  two declarations. The
  [coding principles](../engineering-guidelines/coding-principles.md#implementation-and-verification)
  say to extract shared logic when a third use expresses the same rule. The cleanup uses the same limit
  for the declarations of a type.
  - `VerifiedPrefix` is in `transcript/transcript-source.ts` and in the storage port, which cannot import
    each other. `CapturedTranscriptFile.prefixDigests` writes the two members in full: that file imports
    only `node:` modules.
  - `TextBlock` is in the visible-text file of each provider. A provider cannot import the other
    provider. A neutral file could hold the type, as `json-record.ts` holds `Fields`.
  - `Identity` is a private alias in `claude-advisor-iterations.ts` and in `claude-usage-ledger.ts`. No
    rule keeps these two files apart.
  - Two things are not a second declaration. The history port writes the type of `Fields` in full for
    `LocalHistoryEntry.record`, because `history/` imports no other collector directory. A file can
    give an imported type a short local name, such as `Source` for `CodexRolloutSource`.

## Risks

| Risk | Control |
| --- | --- |
| A change gives a stored ID or a saved parser state different bytes. A replay then stores a message two times, or a lost reply cannot be confirmed. | The golden tests. Stored and hashed data stays plain objects with the same key order. |
| A change to the engine or to storage changes the sequence of the work, and the CLI output does not show it. | The trace comparison. |
| A storage change breaks the API. | `check:collector-api` and `check:collector-postgres`. The storage contract files do not change. |
| A helper moves into a class and the file passes 500 lines. | Give each group of helpers its own small class. Run `bun run habit-hooks --branch main`. |
| A logger call moves and the log prefix changes. | Each logger call stays in `cli.ts`, on its line. |

## Left alone on purpose

- The parser logic, the stored contract, the checkpoint format and the HTTP wire format.
- The names `LocalLLMHistory`, `LocalCollector` and `InMemoryCollectorStorage`.
- The Codex and Claude Code parsers stay separate. They share little. A shared base class would bring
  back the inheritance problem of finding 1.
- Three Codex classes read the same turn events for three different purposes. They stay separate.
- `LocalLLMHistory.readLocalHistory` and `HistoryWindow.between`. No production code calls the first,
  and only the first calls the second. The CLI calls `readLocalHistoryInstants`, which keeps each
  fraction digit of its arguments. `readLocalHistory` is the operation of
  [history.tsp](local-collector/history.tsp) for a TypeScript caller, and the history scenarios use it.
- The field `harness` of a scan entry. `TranscriptBatches` writes it, and no production code reads it.
  The field makes the entry types of the two providers different types, and the contract has the field.
  The owner confirmed this point and the point before it after step 5.

## Decisions

The owner accepted these ten decisions.

1. **Provider class names.** `CodexHistory` and `ClaudeHistory`. The configuration key (`claudePath`),
   the stored `harness` value and the specification all say `claude`.
2. **Test-only methods.** A member that only tests read goes to a test fixture, and the contract loses
   it. Step 5 did that.
3. **Scope of `storage/`.** Step 4 includes `storage/`, which had 150 of the 265 functions and which the
   API runs.
4. **Two shared leaf modules.** `recorded-instant.ts` and `claude-transcript-copy.ts` are in
   `packages/shared`, with `ajv` and `ajv-formats` as its dependencies. `storage/` is then self-contained.
5. **Enforcement.** The PR workflow runs `check:collector-structure`, so that a new function outside a
   class fails the check.
6. **Two preconditions stay preconditions.** The owner decided this after step 5. No constructor checks
   them. A provider does not reject a root that is not an absolute path. `LocalCollector` does not reject
   two providers that have one harness. The contracts state both points. The CLI always meets them. In
   the production code, only `LocalProviders.fromConfig` makes a provider, and it makes at most one for
   each harness. The command gives that method a `GlobalConfig`, which rejects a path that is not
   absolute. A TypeScript caller that makes a provider or a scanner itself must meet them. A check in a
   constructor is a new error for such a caller, so it needs its own scenario.
7. **Reach of the structure rules.** The owner decided this after step 5. Two rules now reach `apps/api`
   and `packages/shared`: the rule against `this` in a static method, and the rule against a relative
   import of the source. The [rule table](#rules-that-keep-the-structure) gives the files. The function
   rule stays with the collector and the two leaf modules, so the functions of `apps/api/src` and of
   `recorded-path.ts` stay. Step 6 did that.
8. **One TypeScript project for each workspace.** The owner decided to plan this as separate work, so
   that Knip can follow `#src/…`. Knip then counts a test as a user of an export. Thus that plan also adds
   a Knip run in production mode, which does not count tests. That run reports an export that only tests
   use, so decision 2 has a check. A member that the owner keeps on purpose gets an exception. This work
   is not started.
9. **Cause and effect before a decision.** The owner asked for an analysis of two points before a
   decision on them. The points are the text of a restored parser, and the different order on Bun and on
   Node.js. The two analyses are done, and
   [Points that later work must know](#points-that-later-work-must-know) has the result of each one. The
   owner has not decided what to change.
10. **The rules of step 7.** The owner approved step 7 with all seven rules. The other choice was the two
    patterns only: the digest and the ID of a native Codex call.

## The review that started the cleanup

The review read the code at commit `21ab8a9`: 65 files, 9,188 lines, 57 classes and 265 top-level
functions in `apps/collector/src`. Of the 265 functions, 68 were exports, and thirteen files had
functions and no class. The [first version of this plan](https://github.com/tomer-mayara/TraceRelic/blob/f88a0d175fca0a1b9a4586e17f210a6000c8f948/docs/specs/local-collector-structure-cleanup.md#findings)
has the detail of each finding. Its line numbers refer to commit `21ab8a9`.

| # | Finding | Fixed in |
| --- | --- | --- |
| 1 | The date reader was an abstract class, and inheritance hid it. Nothing was injected. No class read both providers. The command and the scanner each built the two readers. | Steps 1 and 3 |
| 2 | The base class did three jobs: the date window, the selection of scan sources, and the JSONL reading with batches and digests. | Step 1 |
| 3 | Provider code was in four places, and the scan engine made twelve provider decisions itself. A third provider would need an edit in each place. | Steps 2 and 3 |
| 4 | Functions outnumbered classes by more than four to one. The same small rule had up to six copies. | Step 4 |
| 5 | Directories mixed concerns. `scan/` held parsers, the engine and the schedule. `storage/` held the port, the HTTP client, provider accounting and the session model. Two files sat loose in `src/`. | Step 2 |
| 6 | The limit of 500 lines for a file is the likely reason that helpers left a large class for a file of functions. | Step 4 gives each group of helpers its own small class |
| 7 | Tests reach the source in three ways: package exports, `#src/…` and relative paths. Four production methods have test callers only. | Step 5 |
