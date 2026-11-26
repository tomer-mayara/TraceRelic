# One TypeScript project for each workspace

A developer opens a file of `apps/collector`, `apps/api` or `packages/shared`, and the editor uses the
TypeScript project of that workspace. `bun run typecheck` checks the project of each workspace, and
also all workspaces together. Knip follows a test import through `#src/…`. A second Knip run reports an
export, a type, a file or a dependency that only tests use. A user of the CLI or of the API sees no
change, and no file of a `src/` directory changes.

Affected components: the root (`package.json`, `knip.json`, the PR workflow, the README and the
[cleanup plan](local-collector-structure-cleanup.md)), and `apps/collector`, `apps/api` and
`packages/shared` (new `tsconfig.json` files). Two options of decision 2 also change
`apps/collector/package.json` and `bun.lock`.

**State: the owner approved this plan on 2026-11-25, with the [decisions](#decisions-of-the-owner)
below. The change comes in a second PR.**
[Decision 8 of the collector structure cleanup](local-collector-structure-cleanup.md#decisions) asked
for this plan.

## Problem

Each number is from `main` at `695dc81`.

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
  for each compiler option other than `outDir`. Bun reads the nearest `tsconfig.json` of a source file
  and follows its `extends`, and it ignores `outDir`. A comment in each project file states this rule.
- No project writes a file, because each one inherits `noEmit`. Knip reads `outDir` to find `src/x.ts`
  for `dist/x.js`. TypeScript uses it only for the check of the next point.
- The tests of `apps/api` have their own project, with no `outDir`. They import collector fixtures through
  `#collector-fixture/…`. TypeScript makes those fixtures, and the collector source that they import,
  sources of the project. A project that has an `outDir` reports each such file as outside its root
  directory: 105 errors TS6059. A file that a project reaches only through a package name, such as
  `@tracerelic/shared`, is a library file for TypeScript, and this error does not apply to it.
- A project also checks each file that its own files import. Thus 122 files are in two or more projects.
  `typecheck` stops at the first program that fails, so an error shows one time.
- The project of `packages/shared` changes nothing for Knip. It gives the editor a project for that
  workspace, and a check of that workspace alone.
- The projects have no references between them. A layout with project references needs declaration output
  and a build before each check.

**Type check.** `bun run typecheck` runs five programs: the root project, and then `tsrs -p` for each of
the four projects. `build` calls `typecheck`, as it does today.

**Knip.** `knip.json` marks the production entries, the scripts and the source files with `!`. It names
`src` and `test` in separate patterns, because the production run leaves out the files of each pattern
that has no `!`. The new script `knip:production` runs `knip --production --strict`, and the PR workflow
gets one step that runs it.

| Run | A test counts as a user | What it reports |
| --- | --- | --- |
| `knip` | Yes | An export, a type, a file or a dependency that nothing uses |
| `knip --production --strict`, new | No | An export, a type, a file or a dependency that only tests use. Also a dev dependency that the production source imports |

**README.** One paragraph on the projects, and one on the production run.

## Decisions of the owner

The owner decided each point on 2026-11-25.

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
   `main`, so no exception is necessary now. If one is necessary later, a JSDoc tag on the export is the smallest way. With the
   four project files, the tag is `@internal`: the production run does not report such an export, and the
   default run sees its test. Without the project files, the tag must be `@public`, which hides the
   export from both runs.

## Constraint decisions

| Constraint | Decision | Check |
| --- | --- | --- |
| Behavior | No scenario is new, because no caller can do a new thing. Bun reads the nearest `tsconfig.json` of a source file, so a project file must not change how Bun runs the source. | The sha256 of each compiled `.js` file is the same before and after. `bun build --no-bundle` gives the same code for each `.ts` file before and after. The output comparison and the trace comparison of the [cleanup plan](local-collector-structure-cleanup.md#how-a-step-shows-that-behavior-did-not-change) are identical. `bun run test`. |
| Observability | Out of scope. No signal changes. | None |
| Architecture | The dependency rules do not change. Each project must pass its own type check. Thus the collector and the API cannot use a type that only a test of another workspace brings. Each compiler option other than `outDir` goes in the root `tsconfig.json`. No check keeps that last rule. | `bun run typecheck` with its five programs. `check:collector-deps` gives the same module graph. A probe: with the `lib` line reduced to `ES2022` and `DOM`, the type check must fail. |
| Interface | Out of scope. No TypeSpec contract and no package export changes. | The three `schema:collector-*` scripts |

## Evidence

A worker tried each layout at `dcc77ca`. The manager and two independent reviewers then applied the
recommended change at `695dc81` without a commit, and they ran the layouts and the checks again. Each
number of the two tables is from `695dc81`, other than the row that names `dcc77ca`.

**Layouts and ways that were tried.**

| Layout or way | Result |
| --- | --- |
| A project file in `apps/collector` and in `apps/api` that has only `extends` and `outDir`, as step 5 of the cleanup tried | 52 and 132 errors TS6059: each project inherits the `include` of the root |
| The same, and each workspace has its own `include`, with the API tests in the API project | The API project has 105 errors TS6059 |
| The four files of this plan | No error in the five programs, with `tsrs` and with the `typescript` package (TypeScript 6.0.3) |
| A `require` condition in the `#src/*` map | Knip follows the import. But `require("#src/…")` then loads the source file. Rejected |
| `paths` in `knip.json` | It works only when `dist/` is absent. Rejected |
| A `tsconfig.knip.json`, with the Knip option `--tsConfig` | It works. Each Knip run needs the option, also the run of Habit Hooks. Rejected |
| Project references | Not built |

**Checks of the recommended change.**

| Check with the four files and the new `knip.json` | Result |
| --- | --- |
| The five programs of `typecheck` | No error, and no program writes a file |
| The file list of the root program | The same with and without the four files |
| `knip` | No finding |
| `knip --production`, with and without `--strict` | One report: `better-sqlite3` |
| Probe: an export that only a test imports through `#src/…` | `knip` does not report it. The production run reports it |
| Probe: an export that nothing imports | Both runs report it |
| Probe: a method that only a test calls | No run reports it |
| `knip` with no build | 20 imports not resolved, each one with `#collector-fixture/…` |
| Probe: the root `lib` line reduced to `ES2022` and `DOM` | The root program passes. The collector project fails with 138 errors, the API project with 1, and the project of the API tests with 6. The shared project passes |
| Compiled files | 729 files of the build, 362 of them `.js`: the same bytes with and without the change |
| `bun build --no-bundle` of each `.ts` file | The same bytes for the 363 files. A control with one compiler option in a project file changed the output |
| Module graph of dependency-cruiser | The same: 390 modules and 1807 dependencies |
| All checks of the repository, at `dcc77ca` | Pass. One test failed in the first run by a storage timeout at a high load, and it passed in the second run |
| Time of `typecheck` at a low load | About 0.8 s for the five programs, and about 0.2 s today |

## Risks

The risks of the way with the four project files:

| Risk | Control |
| --- | --- |
| A compiler option other than `outDir` in a project file of a workspace changes how Bun runs the source of that workspace. | A comment in each project file and the README state the rule. No check keeps it. |
| A new folder beside `src`, `test` and `scripts` is in no program, as today: the root `include` names these three folders. | The contributor adds the folder to the `include` of the root file and of the project. |
| A new workspace has no project. | The root program still checks it. The contributor adds a project file and a `-p` run to `typecheck`. |
| A test of a project that has an `outDir` reaches a file of another workspace through a `#…` import. | The type check fails with TS6059. The comment in `apps/api/test/tsconfig.json` explains why that project has no `outDir`. |
| The default Knip run no longer reports an export that only tests import through `#src/…`. | The production run reports it, and the PR workflow runs it. |
| An editor does not choose the nearest `tsconfig.json`. | Not tested. `tsrs -p` for each project is the check. |

## Not solved

- **`#collector-fixture/…` with no build.** Knip still reports these 20 imports as not resolved when
  `dist/` is absent. After a build it resolves them.
- **Members of a class.** See decision 3.

## Steps

One PR, with these commits:

1. The four project files and the `typecheck` script.
2. `knip.json`, the script `knip:production`, the step in the PR workflow, and the move of
   `better-sqlite3` to `devDependencies`.
3. The README, and each place of the cleanup plan that this change makes untrue. These are the point
   about Knip, decision 8, and two sentences of step 6: one about `#src/…` and one about the `lib` line.

The PR shows each check of the table "Constraint decisions" at its head.
