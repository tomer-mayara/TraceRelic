# Knip checks the exports of entry files, and Habit Hooks runs the production pass

A contributor adds an export to an entry file, and no file imports it. Knip reports it: the PR workflow
fails, and so does Habit Hooks when the contributor runs it. A contributor adds an export that only tests
use. Habit Hooks now reports it on the computer of the contributor. Before, only the PR workflow
reported it. A user of the CLI or of the API sees no change. A TypeScript caller of the collector
package loses four names that no contract names.

Affected components: the root, `apps/collector` and `packages/shared`. The root changes `knip.json`, the
script `habit-hooks`, the README and three plans, and the PR workflow with decision 6 A. In
`apps/collector`, five entry files get tags, and two of them lose four names. Two files that declare
such a name change, and so do five test and fixture files. In `packages/shared`, one entry file gets
tags. `apps/api` does not change.

**State: a plan. It waits for the approval of the owner, and no code changes before that.** The owner
decided on 2026-11-25 that Knip must check the exports of entry files, and that Habit Hooks must run
the production pass of Knip. Both points were open in
[One TypeScript project for each workspace](workspace-typescript-projects.md#not-solved). The owner
decided no other point of this plan. Its open points are in
[Decisions for the owner](#decisions-for-the-owner).

## Terms

- **Entry file.** A file that a named subpath of a `package.json` `exports` map gives, or a file that
  an `entry` pattern of `knip.json` matches. The wildcard subpath `./*` makes no file an entry file. The
  test files `*.test.ts` and `*.steps.ts` are entry files. Knip takes each other file under `test/` as
  an entry of another kind, and the new key does not apply to it. This plan calls such a file a fixture.
- **Production source.** The files of `src/` and of `scripts/`, which have a `!` pattern in `knip.json`.
- **Default run.** `knip`. It counts a test as a user. Habit Hooks runs it. The PR workflow does not.
- **Production run.** `bun run knip:production`, which is `knip --production --strict`. It reads only the
  production source. The PR workflow runs it.
- **Report and hint.** A report is a line of a Knip run about the code, and it makes the run fail. A
  hint is a line of the default run about `knip.json`. It does not make the run fail.
- **Habit Hooks.** A contributor starts it with `bun run habit-hooks`. No git hook and no step of the PR
  workflow starts it. The script runs a core package with two plugins. The plugin
  `habit-hooks-typescript` has the Knip sensor: the program that runs Knip and makes findings from its
  reports. A pass is one Knip run of the sensor.
- **Tag.** A JSDoc tag in a comment directly before an export statement. In a statement that exports
  names from another module, `export { … } from "…"`, a tag can also be before one name.
- **Contract.** A file that a `component.yaml` gives as `spec` or `interface`, a TypeSpec file that such
  a file imports, or the README.
- **Probe.** A small change that is made for one check and then removed.

## Problem

Each number is from `main` at `8ebf895`, after a build.

| Problem | Evidence |
| --- | --- |
| No Knip run checks the exports of an entry file. | With the Knip option `--include-entry-exports`, the production run gives 49 reports: 11 exports and 38 types. The default run gives 13: 12 of these types, and the default export of `.habit-hooks/eslint.config.mjs`. |
| Habit Hooks runs only the default run. Thus it does not report an export that only tests use. | Probe: an export that only a test imports through `#src/…`. Habit Hooks passes. The production run fails. |

## The change

This section has the change with option A of each [decision](#decisions-for-the-owner). Another choice
of the owner changes the part that the decision names.

### Part 1. Knip checks the exports of entry files

`knip.json` gets `"includeEntryExports": true` at the top level. Both runs read that key, and so does
each pass of the Knip sensor.

- The production run then reports an export of an entry file that no file of the production source
  imports. These are the 49 reports.
- The default run then reports an export of an entry file that no file imports. Today these are 12 of
  the 49, and the default export of the ESLint configuration. Thus the two runs give 50 reports.
- One entry file is an exception. A test imports the whole module `@tracerelic/shared/logging`, and the
  default run counts that as a use of each of its exports. Only the production run reports a new
  export of that entry file that nothing uses, and Habit Hooks shows it as `test-only-dead-code`.
- The default run then also checks the exports of the test files that are entry files. One such export
  is there today, and two files import it. The exports of a fixture stay with no check.
- The root workspace gets `"includeEntryExports": false`. Its one entry file with an export is
  `.habit-hooks/eslint.config.mjs`, which ESLint loads and no file imports. The cost: no run checks
  an export of a root entry file, now or later.

A report says that no file of the run imports the export. It does not say that the name has no use.
One name gives two reports when an entry file exports it again and no file imports it. One report is
at the entry file, and one is at the file that declares the name. Each report of today gets one of
four resolutions.

| Group | Names | Reports, production and default | Resolution |
| --- | --- | --- | --- |
| A1. Shared logging, `packages/shared/src/logging/index.ts` | `Logger`, `LogLevel`, `LoggerOptions`, `LogLevelName`, `LogRecord`, `LocalFileLogger`, `LocalFileLoggerOptions` | 9 and 0. Two names give two reports | `@public`. The contract is `shared-logging/logging.tsp` and `shared-logging.md` |
| A2. Storage port, `apps/collector/src/storage/collector-storage.ts` | `Identifier`, `Count`, `Revision`, `SourceOrder`, `PrefixDigest`, `VerifiedPrefix`, `ForkPosition`, `UsageKind` | 8 and 7 | `@public`. The contract is `local-collector/storage.tsp` |
| A3. Scan entry, `apps/collector/src/scan/local-collector.ts` | `ScanRejectedError`, `PendingScan`, `MissingSource`, `CopyAssessment`, `EarlierCopy`, `IdentityInventory`, `LocatedSource`, `SourceCopy`, `CorrectionBatchFields`, `ProviderCheckpointFields`, `SavedDecoder`, `UsageCorrection`, `ChatParser`, `DecodedChat` | 18 and 3. Four names give two reports | `@public`. The contract is `local-collector/scan.tsp`, and the README names `ScanRejectedError` |
| A4. Providers, `apps/collector/src/providers/index.ts` | `ClaudeHistory`, `ClaudeTranscriptEntry`, `ClaudeTranscriptSource`, `ClaudeSubagent`, `CodexHistory`, `CodexRolloutEntry`, `CodexRolloutSource` | 7 and 1 | `@public`. The contract is `scan.tsp`, and the README names `CodexHistory` |
| A5. Configuration, `apps/collector/src/config/index.ts` | `GlobalConfig`, `GlobalConfigLoader` | 2 and 0 | `@public`. The contract is `local-collector/config.tsp`, and the README names `GlobalConfigLoader` |
| B. No contract names it, and only tests import it through the entry file | `globalConfigFileSchema`, `GlobalConfigFile`, `CodexSelection` | 3 and 0 | The entry file does not export it |
| C. No contract names it, and no file imports it | `LocalProvider` | 1 and 1 | The entry file does not export it |
| D. The class of the CLI, `apps/collector/src/cli.ts` | `CollectorCli` | 1 and 0 | `@internal`, on the line of the class |
| E. The ESLint configuration of Habit Hooks | The default export | 0 and 1 | The setting of the root workspace |

- **`@public`.** No Knip run reports an export that has this tag. The plan uses it for a name that a
  contract gives to a TypeScript caller: 38 names. Each tag names its contract.
- **Where a tag goes.** A tag before a statement applies to each name of the statement. 17 statements
  get one tag, because Knip reports each of their names. Four statements of the scan entry also have
  names that Knip does not report. There the tag goes before each of the 11 reported names, so that no
  other name gets it. One of the other names, `ScanPendingError`, is in no contract.
- **`@internal`.** The production run does not report such an export. In the default run the export
  still needs a user, and a test is a user. `CollectorCli` gets it: the tests give a storage and
  options to `CollectorCli.run`, and no contract names the class.
- **Groups B and C.** `config/index.ts` loses the line that exports `globalConfigFileSchema` and
  `GlobalConfigFile`. Three test and fixture files then import them from the module that declares them.
  `providers/index.ts` loses `CodexSelection` and `LocalProvider`. `CodexSelection` is an alias of
  `ScanSelection`. The alias goes: the file that declares it, one test and one fixture then use
  `ScanSelection`. `LocalProvider` loses the word `export` in the file that declares it.
- **`LocalFileLogger`.** The production source does not use this class. Only tests use it. The shared
  logging spec gives it to a caller of the package, so the plan keeps it with `@public`.

The rule for a contributor, which the README gets. When Knip reports an export of an entry file:

1. Nothing needs the export: remove it.
2. A contract gives the name to a caller: write `/** @public <contract> */` before the statement, when
   Knip reports each name of the statement. If Knip reports only some of the names, write the tag
   before each reported name. That works only in a statement that exports from another module. Split
   each other statement first.
3. Only tests need the name, and it cannot move to `test/fixtures/`: write `/** @internal <reason> */`.
4. Write no other word that starts with `@` in such a comment. Knip reads each one as a tag.
5. Run Knip for all workspaces: `bunx knip` after a build, and `bun run knip:production`. With
   `--workspace`, the production run reports each export that only another workspace imports. With
   `--fix`, it then removes those exports.

No run checks that a tag is true. The tags `@public`, `@beta` and `@alias` stop both runs for an
export, in each file.

### Part 2. Habit Hooks runs the production pass

The Knip sensor can start a second pass, `knip --production`. It does that only when `entry` and
`project` at the top level of the configuration each have a pattern that ends with `!`. This `knip.json`
has its patterns under `workspaces`. Thus `knip.json` gets two lines at the top level:

```json
"entry": ["These two lines start the production pass of Habit Hooks: see the README!"],
"project": ["These two lines start the production pass of Habit Hooks: see the README!"],
```

Knip does not use these lines, because `knip.json` has a `workspaces` key. The default run prints two
hints that say to remove them. The sensor accepts each text that ends with `!`, so the text says what
the lines are for. Each hint shows the end of that text.

- From each pass, the sensor keeps only the reports about a thing that nothing uses. Such a thing is
  a file, an export, a type, a member of an enum or a dependency. From the second pass, it does not
  keep those about a dependency, and it keeps only what the first pass did not report. Habit Hooks
  shows them as the finding `test-only-dead-code`, and Habit Hooks fails.
- Habit Hooks shows the file of a finding, and not the name or the line. `bun run knip:production` shows
  them.
- The second pass is not the production run. The sensor adds no `--strict`, and it keeps only the
  reports above. Thus Habit Hooks does not show all reports of Knip. Three examples are a dev
  dependency that the production source imports, a dependency that only tests use, and an import that
  no `package.json` lists. A contributor gets such a report from `bunx knip` or from
  `bun run knip:production`.
- The script `habit-hooks` fixes the version of the core package only, and the core package accepts
  each plugin version from 1.5 and below 2. Thus the script also gets the version of its two plugins,
  `habit-hooks-typescript` and `habit-hooks-generic`. That version is 1.5.0, as in a run of today.

### Part 3. The PR workflow runs the default run

The PR workflow gets a step that runs `bunx knip` after the build. CI then enforces the parts of the
change that only the default run checks: see decision 6.

## Decisions for the owner

The recommendation of the manager is the option A of each decision.

1. **The tag for a name of a contract (groups A1 to A5: 38 names, 44 reports).**
   [Decision 4 of the workspace plan](workspace-typescript-projects.md#decisions-of-the-owner) gave
   `@internal` to an export that stays on purpose, because `@public` hides an export from both runs.
   That decision was for an export that only tests use. A name of a contract is another case. For 11 of
   the 38 names, Knip finds no importer, so `@internal` cannot keep them.
   - A: `@public` for each of the 38 names. It gives one rule, and the tag says what the name is. The
     cost: no run reports such a name again. When its contract drops the name, nothing says so.
   - B: `@public` for the 11 names, and `@internal` for the 27 names that have a test as importer.
     It gives a later report of the default run when the last test of a name goes. That holds for 20 of
     the 27: for the 7 names of shared logging, a test imports the whole module. The cost: the tag says
     "internal" for a name that a contract makes public, and a name changes its tag with its tests.
   - C: no tag, and the entry files do not export these names. This way does not work for
     `packages/shared` and for two tests of `apps/api`, which have no other import path. It also
     changes the contracts and the README, which give these names to a caller.
   - D: as A, with the Knip option `ignoreExportsUsedInFile` for types. It gives 19 tags, and not 28.
     The cost: in each file, no run then reports an exported type that only its own file uses.
2. **The four names of no contract (groups B and C).**
   - A: the entry files do not export them. Then no name of no contract needs a `@public` tag. The
     cost: a TypeScript caller cannot name `LocalProvider`, which is in the return type of
     `LocalProviders.fromConfig`. A caller gets `GlobalConfigFile`, which is in the parameter type of
     `fromConfig`, only from its module and not from `./config`.
   - B: `GlobalConfigFile` and `LocalProvider` stay with `@public`, and the other two names go. It
     gives a caller a name for each type of a signature that the caller uses. The cost: two tags
     that no contract supports.
3. **`CollectorCli` (group D).**
   - A: `@internal` on the line of the class. It keeps the tests as they are. The cost: the export
     stays only for the tests. The guide of Habit Hooks for `test-only-dead-code` gives two fixes, to
     connect the code to production or to delete it. The rule of the README then gives a third way.
   - B: the class is not an export, and the tests start the CLI as a child process. It follows the
     guide. The cost: a test then cannot give a storage or options to the CLI, so those tests check
     less. This way has no prototype.
4. **How Habit Hooks gets the production pass.**
   - A: the two lines of part 2, and the version of the two plugins in the script. Habit Hooks keeps
     its default run, and it shows code that only tests use with the guide for that case. The cost:
     two lines that Knip does not use, and two more hints in the default run. The change depends on
     the rule of the sensor in that plugin version.
   - B: a change in Habit Hooks, so that the sensor also reads the `!` patterns under `workspaces`.
     That is 9 lines more and 3 lines less in the sensor. It gives the result of A with no extra line
     in `knip.json`. The cost: it needs a release of Habit Hooks, which is not a step of this plan. A
     run with a changed copy of the sensor gave the results of A with no probe and with two probes.
     That run had no build.
   - C: `args = ["--production", "--strict"]` for the Knip sensor in `.habit-hooks/config.toml`. The
     sensor then runs Knip one time, with the arguments of the production run. It gives no unused
     line and no dependence on the second pass, and it also reports a dependency that only tests use.
     The cost: Habit Hooks then has no default run. It then does not report three things. They are
     a dev dependency that nothing uses, an export of a test file that nothing imports, and an
     `@internal` export with no test. A contributor then gets those reports only from `bunx knip`.
     The finding is `unused-export`, and not `test-only-dead-code`.
   - Two more ways work, and each one costs more. A sensor of our own in `.habit-hooks/` needs two new
     files, and one of them depends on the file layout of the plugin. A script that runs Knip before
     Habit Hooks stops at the first Knip report, so the contributor does not see the other findings.
5. **The behavior check.** The cleanup plan checked each code change with an output comparison and a
   trace comparison of the CLI:
   [two comparisons](local-collector-structure-cleanup.md#how-a-step-shows-that-behavior-did-not-change).
   They ran on a private copy of local transcripts, outside the repository. No such copy exists now.
   - A: no comparison on such a copy. The checks are two comparisons of code, the tests and the
     scenario checks. The comparisons are of the compiled files and of the Bun output of each changed
     source file. The cleanup plan did the same for the change after step 5. Option A needs no
     private copy. The reason: the code that runs differs in one export that `config/index.ts` loses,
     and no production file imports that file.
   - B: a new private copy of local transcripts, new results of `main` to compare with, and then the
     two comparisons. It can find a difference in the output of the CLI on real transcripts. The
     cost: a new private copy.
6. **The default run in the PR workflow.** Three parts of the change have only the default run as their
   check. An `@internal` export needs a test. An export of a test file needs an importer. The default
   export of the ESLint configuration needs the setting of the root workspace. The PR workflow runs no
   default run, and the planning rule says that CI must enforce each changed constraint.
   - A: a new step in the PR workflow that runs `bunx knip` after the build. CI then enforces the three
     parts. It also reports what no CI step reports today. Two examples are a dev dependency that
     nothing uses, and an import in a test that is not listed. The cost: one more step, which can
     make a PR fail for a case that is older than the PR.
   - B: no new step. The cost: only the default run finds the three parts, in Habit Hooks or by
     hand. That does not agree with the planning rule.

Two smaller choices of the manager are in part 1, and the owner can change them. The key is in
`knip.json`, and not a flag: one key reaches both runs, each pass of the sensor and a run by hand.
The root workspace has a setting. The other way is a `@public` tag on the default export of the ESLint
configuration. That tag keeps the check for each other root entry file, but no contract names that
export.

## Constraint decisions

| Constraint | Decision | Check |
| --- | --- | --- |
| Behavior | No scenario is new, because no caller of the CLI or of the API can do a new thing. The tags are comments. Four names leave two entry files. | The sha256 of each file of the build, before and after. Each difference is a tag comment, the export that `config/index.js` loses, an import path in a test, or a source map. The Bun output of each changed source file, before and after: the one difference is that export. `bun run test` and the scenario checks. |
| Observability | Out of scope. No signal changes. The log prefix has the file and the line of each logger call. No logger call moves, because the tag of `cli.ts` is on the line of the class. | The lines of the logger calls of `cli.ts`, before and after |
| Architecture | The dependency rules do not change. Three new rules. An export of an entry file of the production source has a production importer, or it has a tag. An export with `@internal` has a test. An export of a test file has an importer. No run checks that the text of a tag is true. | The production run in the PR workflow for the first rule. The default run for the two other rules: in Habit Hooks, and in the PR workflow with decision 6 A. `check:collector-deps`: three edges go and four come, each one for the four names of groups B and C. |
| Interface | No TypeSpec contract changes. The subpath `./config` of the collector package loses `GlobalConfigFile` and `globalConfigFileSchema`. The subpath `./providers` loses `CodexSelection` and `LocalProvider`. At run time, only `globalConfigFileSchema` goes: the other three are types. | A search of the contracts and of the README for the four names. The three `schema:collector-*` scripts and `check:logging-contract` show that no contract changed. |

## Evidence

Two workers made the investigation, each one with probes, and one of them made a prototype. The manager
and an independent reviewer each built the change of this plan from that prototype, and each one ran
the checks. That change has option A of each decision. A second reviewer read the plan. The change is
not committed. The PR with the code runs each check again.

| Check | Result |
| --- | --- |
| The change | 15 files: `knip.json`, `package.json`, 8 source files and 5 test or fixture files. 28 `@public` tags and 1 `@internal` tag |
| `knip`, with no build and after a build | The same output as on `main`. With no build, these are the 20 imports through `#collector-fixture/…` that are not resolved. It prints 10 hints, and `main` prints 8 |
| `knip --production --strict`, with no build and after a build | No report |
| Habit Hooks with no probe | It passes, with the same one suggestion as on `main` |
| The repository checks | 848 tests pass. So do the scenario checks, lint, the dependency check, the structure check, the schema scripts and Habit Hooks |
| The files of a clean build, against `main` | 19 of 729 files differ: 6 `.js` files and 13 source maps. In the 4 `.js` files of the source, the difference is the tag comments and the one export that `config/index.js` loses. In the 2 `.js` files of tests, it is the import path |
| The Bun output of the 8 changed source files, against `main` | The same for 7 files. `config/index.ts` differs in the one export that it loses |
| The logger calls of `cli.ts` | The same lines in the source and in the compiled file. No other changed source file calls a logger |
| Probe: an export of an entry file that nothing imports | Both runs report it. Habit Hooks fails with `unused-export`. For the entry file of shared logging, only the production run reports it |
| Probe: an export of an entry file that only a test imports | The production run reports it. Habit Hooks fails with `test-only-dead-code` |
| Probe: an export of another source file that only a test imports through `#src/…` | The production run reports it. Habit Hooks fails with `test-only-dead-code`. On `main`, Habit Hooks passes |
| Probe: an export of a test file, and of a fixture, that nothing imports | The default run reports the export of the test file. No run reports the export of the fixture |
| Probe: `CollectorCli` with no tag | The production run reports it |
| Probe: each tag as `@internal` | The default run reports 11 names. The production run reports nothing |
| Probe: a tag before one name | In a statement that exports two names from another module, the production run reports the other name only. In a statement with no `from`, it reports both names |
| The 4 names of groups B and C | No contract, spec, README or `component.yaml` names them. In the collector, 7 source files and 5 test or fixture files name them. No file of `apps/api` or of `packages/shared` names them |
| `config/index.ts` | No production file imports it, by a relative path or through the subpath `./config` |
| The two lines alone, on `main` | Both runs give the same output bytes. The default run prints 2 more hints, and each one shows the end of the text |
| Probe with the two lines: a dev dependency in the production source, and a dependency that only a test uses | Habit Hooks passes in both cases. The production run reports each one |
| The production run for one workspace, `--workspace` | For `apps/collector` it reports 3 types, and for `packages/shared` 13 exports. Another workspace imports each one. On `main`, both runs pass |
| The script `habit-hooks` with the version of the two plugins | The same result as with the script of today |
| Decision 4 C | Habit Hooks passes with no probe. It reports the export that only a test imports as `unused-export`, and the dependency that only a test uses as `unused-dependency`. It does not report the dev dependency in the production source |
| Time of the Knip sensor | About 1 s with one pass and about 1.5 s with two. A run of Habit Hooks takes about 3 s in both cases, because its ESLint sensor takes longer |

## Risks

| Risk | Control |
| --- | --- |
| A contract drops a name later, and the `@public` tag of the name stays. | No check finds this. Each tag names its contract, so a search for the name of the contract finds its tags. |
| A contributor writes `@public` to stop a report, for a name that no contract names. | No check finds this. The README has the rule, and a review reads each new tag. |
| A contributor removes the two top-level lines, because Knip gives a hint to do that. The second pass of Habit Hooks then stops with no message. | The text of the two lines says what they are for, and each hint shows the end of that text. The README explains the lines. |
| A new version of the plugin `habit-hooks-typescript` changes when the sensor starts its second pass. | The script gets the version of the plugin. The README says to repeat the probe of an export that only a test imports after a change of that version. |
| A contributor reads the second pass of Habit Hooks as the production run. | The README says which reports Habit Hooks does not show. |
| A contributor runs the production run with `--workspace`, and then `--fix`. | The README says to run Knip for all workspaces. |
| The `outDir` of `packages/shared/tsconfig.json` goes away. | The production run of the PR workflow then reports 13 exports of `packages/shared`. |

## Not solved

- **Members of a class.** Knip does not check them.
- **Exports and files of a fixture.** No run reports them. The new key does not change that.
- **The truth of a tag.** See the first two risks.
- **Reports that Habit Hooks does not show.** See part 2.
- **When Habit Hooks runs Knip.** It runs the Knip sensor only when its scan has a file of its `files`
  list. With `--branch` or `--file`, a change of only `knip.json` or of a `package.json` gets no Knip
  run. This limit is older than the change.

## Steps

After the approval of the owner, one PR in this order, with the choices of the owner. Each commit passes
its checks.

1. The tags, the four names that leave two entry files, and the test and fixture files. Before this
   commit, the two runs with the key show the 50 reports. Those runs are the failing check of the change.
2. The key `includeEntryExports` at the top level of `knip.json`, with the setting of the root workspace.
3. The two top-level lines in `knip.json`, and the version of the two plugins in the script
   `habit-hooks`. The probe of an export that only a test imports must make Habit Hooks fail.
4. With decision 6 A: the new step of the PR workflow.
5. The documents. The README gets the rule for a contributor and the text about the two lines. It
   says which reports Habit Hooks does not show, and that Habit Hooks shows only the file of a finding.
   It also says to repeat the probe of step 3 after a change of the Habit Hooks version.
   The README, [One TypeScript project for each workspace](workspace-typescript-projects.md) and the
   [cleanup plan](local-collector-structure-cleanup.md) get a correction for each sentence that the
   change makes untrue. This plan gets its state.
