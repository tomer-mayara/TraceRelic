# TraceRelic

TraceRelic is a starter for collecting token usage from Codex and Claude Code sessions. The collector lives in `apps/collector`, the API in `apps/api`, and shared TypeScript code in `packages/shared`.

## Read local Codex and Claude Code history

Pass the configuration file to the collector with `--config`. The supplied file selects the usual Codex and Claude Code directories. Omit `claudePath` to read only Codex. [TypeScript definition](apps/collector/src/config/global-config-schema.ts) · [tracerelic.config.json](tracerelic.config.json)

```json
{ "codexPath": "~/.codex", "claudePath": "~/.claude" }
```

From the repository root, run the history command with an inclusive start and exclusive end. It writes matching records as a JSON array.

```sh
bun run collector history --config ./tracerelic.config.json --from 2026-02-01T00:00:00Z --to 2026-02-02T00:00:00Z
```

The CLI resolves `--config` from the working directory. Within the file, each provider path can be absolute, relative to the file's directory, or start with `~/` for the current user's home. From TypeScript, pass the resolved configuration to `LocalLLMHistoryCodex` or `LocalLLMHistoryClaude`.

```ts
import { GlobalConfigLoader } from "@tracerelic/collector/config";
import { LocalLLMHistoryClaude } from "@tracerelic/collector/history";

const config = await GlobalConfigLoader.load("./tracerelic.config.json");
const reader = new LocalLLMHistoryClaude(config);
const entries = await reader.readLocalHistory(
  new Date("2026-02-01T00:00:00Z"),
  new Date("2026-02-02T00:00:00Z"),
);
```

Run `bun run check:collector-history` to check startup and both readers.

## Scan Codex and Claude Code conversations

Run the one-time scan with a session ID or project directory. It prints a JSON array of sessions with the visible user and assistant text in source order. Two providers can use the same session ID. Each result identifies its provider in `key.harness`.

```sh
bun run collector scan --once --config ./tracerelic.config.json --session 0190a2b3-c4d5-7000-8000-000000000001
bun run collector scan --once --config ./tracerelic.config.json --project .
```

Use `--project <directory>` to select sessions whose recorded working directory is that directory or a descendant. For Claude Code, you can also select the exact transcript directory under `projects/`. Repeat either option to include more sessions. Omit both options to scan all configured roots.

The standalone command uses memory for one invocation. TypeScript callers can pass the same workspace storage to a fresh `LocalCollector` to resume at the last accepted newline. Each batch saves its messages, token measurements, parser state, next byte and prefix digest together. The scanner leaves an unfinished line for the next scan, including a line that ends inside a UTF-8 character.

If a write loses its connection, the scanner checks which bytes storage accepted. When the outcome is still unknown, `scan --once` prints a JSON report to standard error and exits with status 75. The report gives the source, the attempted byte range when available, and a suggested retry time. Run the scan again after reconnecting to resume from storage’s checkpoint.

An append or Codex archive move resumes after the scanner verifies the accepted bytes. A shortened or rewritten transcript is read from the beginning. If repeated rows have no native ID and their individual matches are uncertain, the scanner keeps the original messages and records the affected source lines in `usageDiagnostics`.

Set an optional `installationId` in the configuration when multiple installations scan into one workspace. Each installation keeps its own read position and shares the session's messages and version. Claude rows with a UUID can recover text from an earlier transcript copy. Repeated prompts within a conversation keep their separate positions.

For Codex, each `usage` record identifies a call or the remaining interval between two cumulative reports. A second copy can supply more detail about the same total. For Claude Code, text and tool-only rows can update the same request. Its final report can raise or lower the count. Cache reads and writes are included in input, and separate advisor calls have their own measurements.

`observedTotalTokens` sums the accepted input and output. An explicit zero counts as a measurement. A session without accepted measurements has a null total and unknown coverage. A known gap makes measured coverage partial.

The scanner keeps reading after a damaged complete line. For damaged lines and unsupported usage, including a Claude cache breakdown, `usageDiagnostics` gives the source, line number and byte range. The range includes the terminating newline. Codex keeps independently identified calls and resumes counting cumulative changes from the next reliable snapshot. [Local collector engineering spec](docs/specs/local-collector.md)

## Run the checks

Use Node.js **26.13.1** and Bun **1.4.4**. With nvm installed, run `nvm install` and `nvm use` from this directory. If you need Bun, run `curl -fsSL https://bun.sh/install | bash -s -- bun-v1.4.4` and add `$HOME/.bun/bin` to the front of your `PATH`. [Node.js release](https://nodejs.org/en/blog/release/v26.13.1) · [Bun installation](https://bun.com/docs/installation)

```sh
node --version
bun --version
bun install --frozen-lockfile
bun run lint
bun run test
```

`bun run test` type-checks, compiles, and runs each component's `*.test.ts` suites under `test/unit/`, `test/integration/`, `test/interface/`, and `test/acceptance/`. The collector contract checks run the Cucumber features with their adjacent step definitions. [Test layout](docs/engineering-guidelines/coding-principles.md#test-locations)

Run `bun run check:shared-logging` to build the log record schema, check package dependencies, and run the logging scenarios on Bun and Node. [Shared logging plan](docs/specs/shared-logging.md)

For a suite that spans components, place it in `test/acceptance/` at the repository root. Declare the workspace packages it imports in the root `devDependencies`. The same `bun run test` command runs it.

## Run Habit Hooks

Run the scan manually from the repository root. Install the Bun dependencies above and make `uvx` available by installing uv. The command uses Habit Hooks **1.5.0** with Python **3.11 or later**. [Install uv](https://docs.astral.sh/uv/getting-started/installation/) · [Habit Hooks 1.5.0](https://pypi.org/project/habit-hooks/1.5.0/)

```sh
bun run habit-hooks --all
bun run habit-hooks --file apps/collector/test/integration/environment.test.ts
bun run habit-hooks --branch main
```

ESLint checks TypeScript, TSX, and workspace `.mjs` scripts. Function limits are 60 code lines for TypeScript, 120 for TSX, and 200 for tests and scripts. The file limit is 500 code lines. jscpd flags duplicated blocks of at least 10 lines and 100 tokens. Knip checks dependencies across all workspaces, including during a single-file scan. Review the reported findings as well as the exit status.

Knip's root tool exceptions cover `jscpd` and `ts-morph` for Habit Hooks, and the `@typespec/json-schema` emitter loaded by the storage contract. ESLint's parser uses the TypeScript 6 JavaScript API. `bun run lint` runs Oxlint, and `bun run typecheck` uses `tsrs`.

## Connect to PostgreSQL

From a fresh checkout, copy `.env.example` to `.env`. If you already have a `.env` file, add the `DATABASE_URL` entry to it. The example points to the local Compose service at `127.0.0.1:55432`.

```sh
docker compose up -d --wait db
bun run db:check
```

Expect database `feature_tokens` and PostgreSQL version `18.7`. To stop the database and keep its data, run `docker compose stop db`.
