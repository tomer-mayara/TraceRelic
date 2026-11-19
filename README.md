# TraceRelic

TraceRelic is a starter for collecting token usage from Codex and Claude Code sessions. The collector lives in `apps/collector`, the API in `apps/api`, and shared TypeScript code in `packages/shared`.

## Run the checks

Use Node.js **26.13.1** and Bun **1.4.4**. With nvm installed, run `nvm install` and `nvm use` from this directory. If you need Bun, run `curl -fsSL https://bun.sh/install | bash -s -- bun-v1.4.4` and add `$HOME/.bun/bin` to the front of your `PATH`. [Node.js release](https://nodejs.org/en/blog/release/v26.13.1) · [Bun installation](https://bun.com/docs/installation)

```sh
node --version
bun --version
bun install --frozen-lockfile
bun run lint
bun run test
```

`bun run test` checks types with `tsrs`, builds each workspace with SWC, and runs the compiled tests with Node's built-in test runner. Expect two passing tests. One exercises the collector's native SQLite binding and the other sends a request to Fastify in memory.

## Connect to PostgreSQL

From a fresh checkout, copy `.env.example` to `.env`. If you already have a `.env` file, add the `DATABASE_URL` entry to it. The example points to the local Compose service at `127.0.0.1:55432`.

```sh
docker compose up -d --wait db
bun run db:check
```

Expect database `feature_tokens` and PostgreSQL version `18.7`. To stop the database and keep its data, run `docker compose stop db`.
