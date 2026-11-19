# TraceRelic

TraceRelic is a starter for collecting token usage from Codex and Claude Code sessions. The collector lives in `apps/collector`, the API in `apps/api`, and shared TypeScript code in `packages/shared`.

The [local collector engineering spec](docs/specs/local-collector.md) defines session accounting, remote persistence and the in-memory storage fixture. Run `bun run check:collector-storage` to exercise the fixture and its contract.

## Run the checks

Use Node.js **26.13.1** and Bun **1.4.4**. With nvm installed, run `nvm install` and `nvm use` from this directory. If you need Bun, run `curl -fsSL https://bun.sh/install | bash -s -- bun-v1.4.4` and add `$HOME/.bun/bin` to the front of your `PATH`. [Node.js release](https://nodejs.org/en/blog/release/v26.13.1) · [Bun installation](https://bun.com/docs/installation)

```sh
node --version
bun --version
bun install --frozen-lockfile
bun run lint
bun run test
```

`bun run test` checks types with `tsrs`, builds each workspace with SWC, and runs the compiled tests with Node's built-in test runner. The suite includes storage fixture tests and environment checks for the native SQLite binding and Fastify.

## Run Habit Hooks

Run the scan manually from the repository root. Install the Bun dependencies above and make `uvx` available by installing uv. The command uses Habit Hooks **1.5.0** with Python **3.11 or later**. [Install uv](https://docs.astral.sh/uv/getting-started/installation/) · [Habit Hooks 1.5.0](https://pypi.org/project/habit-hooks/1.5.0/)

```sh
bun run habit-hooks --all
bun run habit-hooks --file apps/collector/src/environment.test.ts
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
