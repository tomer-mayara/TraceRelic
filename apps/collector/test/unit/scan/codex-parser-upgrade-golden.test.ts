// These goldens are byte-exact on purpose. An upgrade reads the lines before an old checkpoint to backfill usage,
// and the cursor then saves the state of the upgraded parser as JSON text, which the scanner compares and hashes.
// To change a golden on purpose: set its text to '' in test/fixtures/parser-upgrade-text.ts, run `bun run build` and
// `node --test apps/collector/dist/test/unit/scan/codex-parser-upgrade-golden.test.js`, review the actual text that
// the failure shows, and paste it as the new golden.
import { test } from "node:test";
import { CodexSessionParser } from "#src/scan/codex-session-parser";
import { CodexParserGoldenFixture as F } from "../../fixtures/codex-parser-golden-fixture.ts";
import { CodexParserGolden as G } from "../../fixtures/codex-parser-golden-text.ts";
import { ParserGolden } from "../../fixtures/parser-golden-fixture.ts";
import { UpgradeGoldenFormat } from "../../fixtures/parser-upgrade-fixture.ts";
import { ParserUpgradeGolden as U } from "../../fixtures/parser-upgrade-text.ts";

// The old checkpoint is at the end of line 32, after the damaged line. A version 1 checkpoint saved only the chat state.
const backfill = F.batches.slice(0, 4);
const savedChat = JSON.parse(G.main[3].state).chat;
const fork = CodexSessionParser.forFork(F.forkPlan, F.forkedAt);
const savedForkChat = JSON.parse(G.fork[1].state).chat;

test("a Codex upgrade from an empty checkpoint rebuilds the chat state while it reads the usage", t =>
  new ParserGolden(new UpgradeGoldenFormat(() => CodexSessionParser.upgrade()), backfill, U.codexFromEmpty).assertOneScan(t));

test("a Codex upgrade from a saved chat state keeps that state while it reads the usage", t =>
  new ParserGolden(new UpgradeGoldenFormat(() => CodexSessionParser.upgrade(savedChat)), backfill, U.codexFromChat).assertOneScan(t));

test("a Codex fork upgrade from an empty checkpoint rebuilds the chat state while it reads the usage", t =>
  new ParserGolden(new UpgradeGoldenFormat(() => fork.upgrade?.()), F.forkBatches, U.forkFromEmpty).assertOneScan(t));

test("a Codex fork upgrade from a saved chat state keeps that state while it reads the usage", t =>
  new ParserGolden(new UpgradeGoldenFormat(() => fork.upgrade?.(savedForkChat)), F.forkBatches, U.forkFromChat).assertOneScan(t));
