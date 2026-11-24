// These goldens are byte-exact on purpose. An upgrade reads the lines before an old checkpoint to backfill usage,
// and the cursor then saves the state of the upgraded parser as JSON text, which the scanner compares and hashes.
// To change a golden on purpose: set its text to '' in test/fixtures/parser-upgrade-text.ts, run `bun run build` and
// `node --test apps/collector/dist/test/unit/scan/claude-parser-upgrade-golden.test.js`, review the actual text that
// the failure shows, and paste it as the new golden.
import { test } from "node:test";
import { ClaudeSessionParser } from "#src/scan/claude-session-parser";
import { ClaudeParserGoldenFixture as F } from "../../fixtures/claude-parser-golden-fixture.ts";
import { ClaudeParserGolden as G } from "../../fixtures/claude-parser-golden-text.ts";
import { ParserGolden } from "../../fixtures/parser-golden-fixture.ts";
import { UpgradeGoldenFormat } from "../../fixtures/parser-upgrade-fixture.ts";
import { ParserUpgradeGolden as U } from "../../fixtures/parser-upgrade-text.ts";

// The old checkpoint is at the end of the last line. A version 1 checkpoint saved only the chat state.
const subagent = ClaudeSessionParser.forSource(false, F.subagent);
const earlierCopy = ClaudeSessionParser.forSource(true);
const savedSubagentChat = JSON.parse(G.subagent[1].state);
const savedEarlierCopyChat = JSON.parse(G.earlierCopy[1].state);

test("a Claude subagent upgrade from an empty checkpoint rebuilds the chat state while it reads the usage", t =>
  new ParserGolden(new UpgradeGoldenFormat(() => subagent.upgrade?.()), F.subagentBatches, U.subagentFromEmpty).assertOneScan(t));

test("a Claude subagent upgrade from a saved chat state keeps that state while it reads the usage", t =>
  new ParserGolden(new UpgradeGoldenFormat(() => subagent.upgrade?.(savedSubagentChat)), F.subagentBatches, U.subagentFromChat)
    .assertOneScan(t));

test("an upgrade of an earlier Claude copy from an empty checkpoint rebuilds the chat state while it reads the usage", t =>
  new ParserGolden(new UpgradeGoldenFormat(() => earlierCopy.upgrade?.()), F.earlierCopyBatches, U.earlierCopyFromEmpty)
    .assertOneScan(t));

test("an upgrade of an earlier Claude copy from a saved chat state keeps that state while it reads the usage", t =>
  new ParserGolden(new UpgradeGoldenFormat(() => earlierCopy.upgrade?.(savedEarlierCopyChat)), F.earlierCopyBatches,
    U.earlierCopyFromChat).assertOneScan(t));
