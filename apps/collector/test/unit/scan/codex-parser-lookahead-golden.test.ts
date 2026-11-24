// These goldens are byte-exact on purpose. Message IDs are SHA-256 digests of JSON text or native IDs, and the
// lookahead decides which one a message gets and how its text is split. The same batches are pinned with and
// without the lookahead, so that the difference stays visible. To change a golden on purpose: set its text to ''
// in test/fixtures/codex-parser-paths-text.ts, run `bun run build` and
// `node --test apps/collector/dist/test/unit/scan/codex-parser-lookahead-golden.test.js`, review the actual text
// that the failure shows, and paste it as the new golden.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexSessionParser } from "#src/scan/codex-session-parser";
import { CodexParserPathsFixture as F } from "../../fixtures/codex-parser-paths-fixture.ts";
import { CodexParserPathsGolden as G } from "../../fixtures/codex-parser-paths-text.ts";
import { ParserGolden } from "../../fixtures/parser-golden-fixture.ts";

const [first] = F.lookahead;

test("a Codex scan with a lookahead splits and identifies earlier messages with the records of later batches", t =>
  new ParserGolden(CodexSessionParser, F.lookahead, G.withLookahead).assertOneScan(t, async parser => {
    const fresh = JSON.stringify(parser.snapshot());
    // TranscriptCursor.decode gives the first batch, the later batches, the accepted line and the damaged lines.
    await parser.prepareLookahead(first.entries, F.lookaheadTail(), 0, first.damagedLines);
    assert.equal(JSON.stringify(parser.snapshot()), fresh);
  }));

test("the same Codex batches without a lookahead keep the joined event text and fallback IDs", t =>
  new ParserGolden(CodexSessionParser, F.lookahead, G.withoutLookahead).assertOneScan(t));
