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

Run `watch` to pick up new chats while the collector is running. It scans immediately and then every 60 seconds. Use the same session and project selectors, or choose a different interval in milliseconds.

```sh
bun run collector watch --config ./tracerelic.config.json --interval-ms 5000
```

Each pass writes one JSON line to standard output. For example, `{"status":"complete","newSessions":1,"oldestPendingAgeMs":null}` means storage accepted one new session and no source is waiting. When storage is unavailable, the report includes `retryAt` and the collector waits until then to retry. A slow scan skips any ticks it spans. Press Ctrl-C to finish the active pass and exit.

By default, the standalone CLI keeps its workspace in memory for the life of the process. Each `watch` pass uses that same workspace. TypeScript callers can pass the same workspace storage to a fresh `LocalCollector` to resume at the last accepted newline. Each batch saves its messages, token measurements, parser state, next byte and prefix digest together. The scanner leaves an unfinished line for the next scan, including a line that ends inside a UTF-8 character.

If a write loses its connection, the scanner checks which bytes storage accepted. When the outcome is still unknown, `scan --once` prints a JSON report to standard error and exits with status 75. The report gives the source, the attempted byte range when available, and a suggested retry time. If storage cannot list the acknowledged sources, the report identifies the affected selection in `scope`. Run the scan again after reconnecting to resume from storage’s checkpoint.

If storage rejects a batch, the scanner stops reading that file and continues with the other selected files. The CLI writes the source and byte range of each rejected batch as a JSON line to standard error. When the scan finishes, it prints the accepted session views to standard output and exits with status 1. TypeScript callers can read the views and diagnostics from `ScanRejectedError.sessions` and `.rejections`. After you correct the file, a scan using the same storage resumes from the last accepted checkpoint.

A collector using the same workspace storage can report a transcript that disappeared between scans. It checks the selected installation and all possible file locations, including the Codex archive. A successful scan writes one `missing` report to standard error with the last accepted byte and the last complete byte seen. The session lists the source in `missingSources` until it returns. For example, if storage accepted 70 tokens through byte 420, the total stays 70. Coverage stays `reported` if 420 was the last complete byte. It becomes `partial` if the scanner saw a complete line ending at byte 500.

An append or Codex archive move resumes after the scanner verifies the accepted bytes. A shortened or rewritten transcript is read from the beginning. If repeated rows have no native ID and their individual matches are uncertain, the scanner keeps the original messages and records the affected source lines in `usageDiagnostics`.

Set an optional `installationId` in the configuration when multiple installations scan into one workspace. Each installation keeps its own read position and shares the session's messages and version. Claude rows with a UUID can recover text from an earlier transcript copy. Repeated prompts within a conversation keep their separate positions.

For Codex, each `usage` record identifies a call or the remaining interval between two cumulative reports. A second copy can supply more detail about the same total. For Claude Code, text and tool-only rows can update the same request. Its final report can raise or lower the count. Cache reads and writes are included in input, and separate advisor calls have their own measurements.

A Codex fork keeps its copied conversation and identifies its parent in `metadata.parentSessionId`. To verify the fork on its first scan, include both sessions in the selection. The scanner matches their usage at the fork, so a parent that went from 200 to 260 tokens and a child that went from 200 to 225 report 260 and 25 respectively. If the parent is unavailable, `unresolved-codex-fork` identifies the first uncertain usage. The scanner can still count a request independently tied to a child turn. When the parent becomes available, scanning both sessions against the same storage can recover the remaining usage even if the child file has no new bytes.

A Claude fork or subagent keeps its own chat and links to its parent. If it copies a 100-token parent call and makes a 25-token request, the parent reports 100 and the child reports 25. While ownership is uncertain, `unresolved-claude-fork` identifies the first affected row in each source. A parent scanned later, even from a different installation using the same workspace storage, can resolve that row without reopening the child file.

`observedTotalTokens` sums the accepted input and output. An explicit zero counts as a measurement. A session without accepted measurements has a null total and unknown coverage. A known gap makes measured coverage partial.

The scanner keeps reading after a damaged complete line. For damaged lines and unsupported usage, including a Claude cache breakdown, `usageDiagnostics` gives the source, line number and byte range. The range includes the terminating newline. Codex keeps independently identified calls and resumes counting cumulative changes from the next reliable snapshot. [Local collector engineering spec](docs/specs/local-collector.md)

## Run the local collector API

The API stores accepted sessions and checkpoints in PostgreSQL. Set `DATABASE_URL` and supply the trusted collector credential file. On startup the API applies its migrations, then listens on `127.0.0.1:3000`. Set `PORT` to choose another port.

```sh
docker compose up -d --wait db
bun run build
export DATABASE_URL=postgresql://tracker:tracker_local@127.0.0.1:55432/feature_tokens
TRACERELIC_COLLECTOR_CREDENTIALS_FILE=/path/to/credentials.json bun run collector-api
```

Restart the API against the same database to resume from the last accepted checkpoint. The database role must be able to create the `tracerelic_collector` schema and apply migrations there. [API migrations](apps/api/src/migrations)

The file is a JSON array. For each issued bearer token, store its lowercase SHA-256 digest, workspace, installation and expiry time. To get the digest of a token in `TRACERELIC_COLLECTOR_TOKEN`, run `printf %s "$TRACERELIC_COLLECTOR_TOKEN" | openssl dgst -sha256`. Two installations in one workspace share sessions and keep their own checkpoints.

```json
[
  {
    "tokenSha256": "<64 lowercase hex digits>",
    "workspaceId": "research",
    "installationId": "desktop",
    "expiresAt": "2030-01-01T00:00:00Z"
  }
]
```

For example, set `TRACERELIC_COLLECTOR_TOKEN` to the issued token and read a session. An unknown session returns `{"session":null}`. Each batch commit reports its outcome and elapsed milliseconds on the server. The build writes the routes and response codes to `apps/api/dist/contracts/openapi.json`. The adjacent `collector-api.schema.json` contains the request validation rules, including cross-field checks for batches and checkpoints. [Version 1 HTTP contract](docs/specs/collector-api/main.tsp)

```sh
curl --header "Authorization: Bearer $TRACERELIC_COLLECTOR_TOKEN" --json '{"harness":"codex","sessionId":"planning"}' \
  http://127.0.0.1:3000/v1/collector/session
```

## Sync the collector to an API

Build the collector, set `TRACERELIC_COLLECTOR_TOKEN` in the scanner's environment to the issued bearer token, and set `TRACERELIC_COLLECTOR_API_URL` to the API origin. Use HTTPS for remote services. For the local API above, use its loopback address.

```sh
bun run build
export TRACERELIC_COLLECTOR_API_URL=http://127.0.0.1:3000
bun run collector scan --once --config ./tracerelic.config.json
```

The same settings apply to `bun run collector watch --config ./tracerelic.config.json`. The credential selects the workspace and installation. If the configuration supplies an `installationId`, it must match the credential. A restarted scanner reads the checkpoint from the API. After a lost reply, this lets it confirm the accepted bytes and count each call once.

TypeScript callers can pass `new HttpCollectorStorage(apiUrl, token)` from `@tracerelic/collector/http-storage` to the scanner. Each HTTP request has a ten-second timeout, including the response body.

When the API rate-limits a request or is temporarily unavailable, the collector reports `retryAt`. An automatic retry waits at least one second and honors a longer `Retry-After` value. A one-time scan exits with status 75 if work is pending. A rejected credential stops either command with status 1. A rejected or oversized batch identifies its source and byte range, and other selected files can still sync.

Run `bun run check:collector-api` to check workspace isolation, the storage contract, and scanner restarts after a dropped request or reply over loopback HTTP.

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

Run `bun run check:collector-postgres` to check competing writes, rollback and retry, and API restarts against PostgreSQL. The same command runs the storage contract and scans two example chats through the HTTP client and API. [Two-chat scenario](apps/collector/test/acceptance/scan/two-chats.feature)

Database tests start disposable PostgreSQL 18.7 containers on loopback. To reuse a test server, set `TRACERELIC_TEST_DATABASE_URL` to a database where the test role can create databases. Each fixture creates a uniquely named database and removes it when it finishes.

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

Knip's root tool exceptions cover `jscpd` and `ts-morph` for Habit Hooks and the HTTP, OpenAPI and JSON Schema libraries loaded by TypeSpec. ESLint's parser uses the TypeScript 6 JavaScript API. `bun run lint` runs Oxlint, and `bun run typecheck` uses `tsrs`.

## Connect to PostgreSQL

From a fresh checkout, copy `.env.example` to `.env`. If you already have a `.env` file, add the `DATABASE_URL` entry to it. The example points to the local Compose service at `127.0.0.1:55432`.

```sh
docker compose up -d --wait db
bun run db:check
```

Expect database `feature_tokens` and PostgreSQL version `18.7`. To stop the database and keep its data, run `docker compose stop db`.
