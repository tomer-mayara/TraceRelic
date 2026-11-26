# One TypeScript project for each workspace

A developer opens a file of `apps/collector`, `apps/api` or `packages/shared`, and the editor uses the
TypeScript project of that workspace. `bun run typecheck` checks the project of each workspace, and
also all workspaces together. Knip follows a test import through `#src/…`. A second Knip run does not
count tests. It reports an export, a type, a file or a dependency that the production source does not
use. A user of the CLI or of the API sees no change, and no file of a `src/` directory changes.

Affected components: the root (`package.json`, `knip.json`, the PR workflow, the README and the
[cleanup plan](local-collector-structure-cleanup.md)), and `apps/collector`, `apps/api` and
`packages/shared` (new `tsconfig.json` files). The change also moves one dependency in
`apps/collector/package.json` and in `bun.lock`.

**State: done in [PR 38](https://github.com/tomer-mayara/TraceRelic/pull/38).** The owner approved the
plan on 2026-11-25, as [PR 37](https://github.com/tomer-mayara/TraceRelic/pull/37) has it, with the
[decisions](#decisions-of-the-owner) below. PR 38 then added what the change and its reviews found.
These are the three cases of Bun, new rows in the second table of [Evidence](#evidence), and four
points of [Not solved](#not-solved). PR 38 also corrected one statement of the approved plan. That
statement said that the project of `packages/shared` changes nothing for Knip. The `outDir` of that
project has two effects.
[Decision 8 of the collector structure cleanup](local-collector-structure-cleanup.md#decisions) asked
for this plan.

## Problem

This is the state before the change. Each number is from `main` at `695dc81`.

| Problem | Evidence |
| --- | --- |
| Knip does not follow `#src/…`. It resolves such an import to the compiled file in `dist/`. It finds the source of a compiled file only through the `outDir` of a `tsconfig.json` in the same workspace, and no workspace has one. | Knip reports an export that only a test imports through `#src/…` as not used. With no build, it reports 116 imports as not resolved: 96 with `#src/…` and 20 with `#collector-fixture/…`. |
| The repository has one TypeScript project, at the root. An editor uses it for each file. | In the editor, a file of the collector sees the types of Bun, because one test fixture of `packages/shared` imports `bun`. |
| No check keeps the `lib` line of the root `tsconfig.json`, which declares `Array.fromAsync` and `Promise.withResolvers`. | With `"lib": ["ES2022", "DOM"]`, `bun run typecheck` passes, for the same reason. |
| No check finds, on purpose, an export that only tests use. | Knip counts a test as a user of an export where it can follow the import. It reports such an export only where it cannot: through `#src/…`. The PR workflow has no Knip step. |

## The change

**Four project files.** Each file extends the root `tsconfig.json`. Three of them have one compiler
option, `outDir`. The fourth has none.

| File | `include` | `outDir` |
| --- | --- | --- |
| `apps/collector/tsconfig.json` | `src/**/*.ts`, `test/**/*.ts` | `dist` |
| `packages/shared/tsconfig.json` | `src/**/*.ts`, `test/**/*.ts` | `dist` |
| `apps/api/tsconfig.json` | `src/**/*.ts`, `scripts/**/*.ts` | `dist` |
| `apps/api/test/tsconfig.json` | `**/*.ts` | None |

- The root `tsconfig.json` does not change. It stays the project that has all files, and the one place
  for each compiler option other than `outDir`. Bun 1.4.3 also reads a project file, with its `extends`,
  in three cases. `bun build` reads the nearest `tsconfig.json` of a source file. A Bun run reads the
  compile options from the `tsconfig.json` of its working directory, and it does not look in a parent
  directory. A Bun run reads the path aliases (`paths`) from the nearest `tsconfig.json` of each file
  that imports. Bun ignores `outDir`. A comment in each project file and the README say where a compiler
  option goes.
- No project writes a file, because each one inherits `noEmit`. Knip reads `outDir` to find `src/x.ts`
  for `dist/x.js`. TypeScript uses it only for the check of the next point.
- The tests of `apps/api` have their own project, with no `outDir`. They import collector fixtures through
  `#collector-fixture/…`. TypeScript makes those fixtures, and the collector source that they import,
  sources of the project. A project that has an `outDir` reports each such file as outside its root
  directory (TS6059). One API project that has its tests gives 105 such errors. The error does not
  apply to a file that a project reaches only through an import of a package, such as
  `@tracerelic/shared`. TypeScript checks such a file, but it does not count the file as output of the
  project. An import that starts with `#` does not get this treatment.
- A project also checks each file that its own files import. Thus 122 files are in two or more of the
  four projects, and a project can show an error in a file of another workspace. `typecheck` stops at
  the first program that fails. Its output does not name that program.
- The project of `packages/shared` gives the editor a project for that workspace, and a check of that
  workspace alone. Its `outDir` has two effects. First, Knip follows an import of `@tracerelic/shared`
  to the source of the package. Second, TypeScript reports a file of the project that imports a file
  outside `packages/shared` by a relative path (TS6059). The two Knip runs of the repository give the
  same output without that `outDir`, because they do not check the exports of an entry file. A run with
  `--include-entry-exports` shows the difference.
- The projects have no references between them. A layout with project references needs declaration output
  and a build before each check.

**Type check.** `bun run typecheck` runs five programs: the root project, and then `tsrs -p` for each of
the four projects. `build` calls `typecheck`, as before.

**Knip.** `knip.json` marks the production entries, the scripts and the source files with `!`. It names
`src` and `test` in separate patterns, because the production run leaves out the files of each pattern
that has no `!`. The scripts are production code for Knip: the one script, `apps/api/scripts/check-db.ts`,
is the command `bun run db:check`. The new script `knip:production` runs `knip --production --strict`,
and the PR workflow gets one step that runs it. Habit Hooks runs only the default run, and the PR
workflow runs only the production run.

| Run | A test counts as a user | What it reports |
| --- | --- | --- |
| `knip` | Yes | An export, a type, a file or a dependency that nothing uses |
| `knip --production --strict`, new | No | An export, a type, a file or a dependency that the production source does not use. Also a dev dependency that the production source imports |

No run checks the members of a class, the exports of an entry file, or the use of a file under `test/`:
see [Not solved](#not-solved).

**README.** Three paragraphs in the section "Run the checks": the projects, the type check, and the
production run.

## Decisions of the owner

The owner decided each point on 2026-11-25. This section has the text of that day, so it describes the
state before the change.

1. **The layout: the four project files.** Three ways give the new check for an export that only tests
   use. They are different in what they add and in what they cost. Only the first one gives the two
   things that decision 8 names: Knip follows `#src/…`, and an editor has a project for each workspace.

   | | Four project files | Production run alone | Production run and one check file |
   | --- | --- | --- | --- |
   | The default Knip run follows `#src/…` | Yes | No | No |
   | The default Knip run reports an export that only tests import through `#src/…` | No: only the production run reports it | Yes | Yes |
   | An editor has a project for each workspace | Yes | No | No |
   | A type check with no types of Bun, which keeps the `lib` line | The collector, the API and the API tests | None | The collector |
   | New files that Bun reads when it runs the source | 4 | 0 | 0 |
   | `include` lists to maintain | 4 | 0 | 1 |
   | Programs of `typecheck`, and its time at a low load | 5, about 0.8 s | 1, about 0.2 s, as today | 2, not measured |
   | Behavior checks that the change needs | Compiled files, Bun output, output comparison, trace comparison | None | None |

   The check file of the third way is a file at the root with another name, for example
   `tsconfig.collector-check.json`. It extends the root file and includes only the collector. Bun, an
   editor and Knip do not read a file with that name. The default Knip run is not in the PR workflow:
   Habit Hooks and a contributor run it.
2. **`better-sqlite3`: option A.** With the new `knip.json`, the production run reports one thing on
   `main`. `better-sqlite3` is a dependency of `apps/collector`, and only
   `test/integration/environment.test.ts` imports it. The new step of the PR workflow fails until one of
   three changes is made.
   - A: move it to `devDependencies`, also in `bun.lock`. `@tracerelic/collector` is a private package,
     and each install also installs the dev dependencies. With `--strict`, the production run reports a
     later import of `better-sqlite3` from the production source.
   - B: keep it in `dependencies`, and add `better-sqlite3!` to `ignoreDependencies` of the `apps/*` entry
     of `knip.json`.
   - C: remove the dependency, its types and its environment test, if the collector has no plan for
     SQLite. A README example names that test file. A variant keeps the test and writes it with
     `node:sqlite` of Node.js.
3. **Members of a class: no check.** [Decision 2](local-collector-structure-cleanup.md#decisions) is
   about a member that only tests read. Knip checks exports, types, files and dependencies. It does not
   check the members of a class or the fields of an object. Thus the production run does not check
   decision 2. It checks the same rule for an export. The things that the owner keeps need no exception:
   `LocalLLMHistory.readLocalHistory` with `HistoryWindow.between`, and the field `harness`. This plan
   adds no check for members: that would be a script of our own to maintain.
4. **An export that stays on purpose: no exception now.** The production run reports no export on
   `main`, so no exception is necessary now. If one is necessary later, a JSDoc tag on the export is the
   smallest way. With the four project files, the tag is `@internal`: the production run does not report
   such an export, and the default run sees its test. Without the project files, the tag must be
   `@public`, which hides the export from both runs.

## Constraint decisions

| Constraint | Decision | Check |
| --- | --- | --- |
| Behavior | No scenario is new, because no caller can do a new thing. Bun reads a project file when it builds or runs the source: see the three cases in [The change](#the-change). In each case Bun gets only the root options, because a project file adds `include`, and three of the four files also add `outDir`. Bun ignores both options. Before the change, a run that starts in a workspace directory read no compile options. Now it reads the root options. The checks show no difference. | The sha256 of each compiled `.js` file is the same before and after. `bun build --no-bundle` gives the same code for each `.ts` file before and after. The CLI gives the same bytes when it starts in `apps/collector`, with and without the project file. The output comparison and the trace comparison of the [cleanup plan](local-collector-structure-cleanup.md#how-a-step-shows-that-behavior-did-not-change) are identical. `bun run test`. |
| Observability | Out of scope. No signal changes. | None |
| Architecture | The dependency rules do not change. Each project must pass its own type check. Thus the collector and the API cannot use a type that only a test of another workspace brings. Each compiler option other than `outDir` goes in the root `tsconfig.json`. No check keeps that last rule. | `bun run typecheck` with its five programs. `check:collector-deps` gives the same module graph. A probe: with the `lib` line reduced to `ES2022` and `DOM`, the type check must fail. |
| Interface | Out of scope. No TypeSpec contract and no package export changes. | The three `schema:collector-*` scripts |

## Evidence

A worker tried each layout before the plan was written. The manager and two independent reviewers then
applied the recommended change at `695dc81` without a commit, and they ran the layouts and the checks
again. The second table has the numbers of the change as PR 38 made it. The description of that PR has
the results of all checks of the repository.

**Layouts and ways that were tried.**

| Layout or way | Result |
| --- | --- |
| A project file in `apps/collector` and in `apps/api` that has only `extends` and `outDir`, as step 5 of the cleanup tried | 52 and 132 errors TS6059: each project inherits the `include` of the root |
| The same, and each workspace has its own `include`, with the API tests in the API project | The API project has 105 errors TS6059 |
| The four files of this plan | No error in the five programs, with `tsrs` and with the `typescript` package, which reports version 6.0.3 |
| A `require` condition in the `#src/*` map | Knip follows the import. But `require("#src/…")` then loads the source file. Rejected |
| `paths` in `knip.json` | It works only when `dist/` is absent. Rejected |
| A `tsconfig.knip.json`, with the Knip option `--tsConfig` | It works. Each Knip run needs the option, also the run of Habit Hooks. Rejected |
| Project references | Not built |

**Checks of the recommended change.**

| Check with the four files and the new `knip.json` | Result |
| --- | --- |
| The five programs of `typecheck` | No error, and no program writes a file |
| The file list of the root program | The same with and without the four files |
| `knip` | No finding. It prints 8 configuration hints, as before the change |
| Both Knip runs without the `outDir` of the shared project | The same output, with a build and with no build |
| The same, with `--include-entry-exports` and after a build | Without that `outDir`, the production run reports 13 more exports. The default run reports 17 more exports and 5 more types. Each one is in `packages/shared`. With the `outDir`, the production run does not report the 13, because production source imports them through the package name |
| Probe: a test of `packages/shared` that imports a collector source file by a relative path | With the `outDir`, the shared project fails with TS6059. Without it, the type check, `check:collector-deps` and the structure rule pass |
| `knip --production --strict`, before the move of `better-sqlite3` | One report: `better-sqlite3`. After the move, no finding |
| Probe: an import of `better-sqlite3` in the production source, after the move | The production run reports a dependency that is not listed |
| The two lock lines of the move | The same lines that `bun install` writes. `bun install --frozen-lockfile` does not see such a move, so it is not the check |
| Probe: an export that only a test imports through `#src/…` | `knip` does not report it. The production run reports it |
| Probe: an export that nothing imports | Both runs report it |
| Probe: a method that only a test calls | No run reports it |
| Both runs with the Knip option `--include-entry-exports` | The production run gives 49 reports: 11 exports and 38 types. The default run gives 12 of these type reports, and one export of an ESLint configuration file |
| Probe: an export of a fixture that nothing imports, and a fixture file that nothing imports | No run reports them. Both runs report such an export in `src/` |
| Probe: an import of `ts-morph`, a package of the root list `ignoreDependencies`, in the production source | The production run does not report it |
| `knip` with no build | 20 imports not resolved, each one with `#collector-fixture/…` |
| Probe: the root `lib` line reduced to `ES2022` and `DOM` | The root program passes. The collector project fails with 138 errors, the API project with 1, and the project of the API tests with 6. The shared project passes. The output of `bun run typecheck` is the command line and the 138 error lines |
| Compiled files | 729 files of the build, 362 of them `.js`: the same bytes with and without the change |
| `bun build --no-bundle` of each `.ts` file | The same bytes for the 363 files. A control with one compiler option in the collector project changed 95 of them |
| A Bun run that starts in a workspace directory | Before, it read no compile options: for these, Bun does not look in a parent directory. Now it reads the root options through the project file. The CLI gives the same bytes from `apps/collector`, with and without the project file. The logging scenarios, which Bun runs from `packages/shared`, pass |
| Path aliases in a Bun run | Bun reads `paths` from the nearest `tsconfig.json` of each file that imports, also through `extends`. No `tsconfig.json` of the repository has `paths`, so no run changes |
| Module graph of dependency-cruiser | The same: 390 modules and 1807 dependencies. One edge to `better-sqlite3` has the type of a dev dependency now |
| Time | `bun run typecheck` with its five programs takes 0.8 s to 1.1 s, in three measurements at a load average of 3 to 11. The root program alone takes 0.2 s to 0.4 s |

## Risks

The risks of the way with the four project files:

| Risk | Control |
| --- | --- |
| A project file gets a compiler option other than `outDir`. That option can change what Bun builds and runs. | A comment in each project file and the README state the rule. No check keeps it. |
| A new source folder is not in the project of its workspace. The projects of `apps/collector` and of `packages/shared` name only `src` and `test`. A folder that the root `include` does not name is also not in the root program, as before. | The contributor adds the folder to the `include` of the root file and of the project. The README states this. |
| A new workspace has no project. | The root program still checks it. The contributor adds a project file and a `-p` run to `typecheck`. The README states this. |
| A file of a project that has an `outDir` reaches a file of another workspace through a `#…` import or a relative path. | The type check fails with TS6059. The comment in `apps/api/test/tsconfig.json` explains why that project has no `outDir`. |
| The default Knip run no longer reports an export that only tests import through `#src/…`. Habit Hooks runs only that run. | The production run reports it, and the PR workflow runs it. A contributor sees the report before a push only from `bun run knip:production`. |
| An editor does not choose the nearest `tsconfig.json`. | The project service of the `typescript` package opened ten sample files in the nearest project. No editor was tested. `tsrs -p` for each project is the check. |

## Not solved

- **`#collector-fixture/…` with no build.** The default Knip run still reports these 20 imports as not
  resolved when `dist/` is absent. After a build it resolves them. The production run passes with no
  build.
- **Members of a class.** See decision 3.
- **Exports of an entry file.** No Knip run checks the exports of an entry file: Knip takes them as the
  public surface of a package. An entry file is a file that a `package.json` names in `exports`, or an
  entry of `knip.json`. With the Knip option `--include-entry-exports`, the production run gives 49
  reports: 11 exports and 38 types. Each report is an export that no file of the production source
  imports. It does not show that the production source has no use for the name. The same file can use
  it, and another file can import it from the module that declares it. The default run gives 12 of the
  type reports, so no file imports those exports. Tests or fixtures import the other ones. Some of them
  are public on purpose, for example `LocalFileLogger`, which the shared logging spec names. The owner
  has not decided on this point.
- **Files under `test/`.** For the default run, each file under `test/` is an entry, and the production
  run does not read these files. Thus no run reports an export of a fixture, or a fixture file, that
  nothing imports. This limit is older than the change.
- **The production run in Habit Hooks.** The Knip sensor of Habit Hooks is in the plugin
  `habit-hooks-typescript` 1.5.0. It reads `entry` and `project` at the top level of `knip.json`, and it
  starts a production pass only when both have a `!` mark. This `knip.json` has them in `workspaces`,
  so the sensor runs only the default run.
- **The root list `ignoreDependencies`.** Knip applies the six packages of that list to each workspace.
  Thus the production run does not report an import of one of them from the production source.

## Steps

PR 38 made the change in four commits:

1. The four project files and the `typecheck` script.
2. `knip.json`, the script `knip:production`, the step in the PR workflow, and the move of
   `better-sqlite3` to `devDependencies`.
3. The README.
4. This plan, and the places of the cleanup plan that name this work. The places are one sentence and
   one paragraph of step 6, the point about Knip, and decision 8.

The description of the PR has each check of the table "Constraint decisions".
