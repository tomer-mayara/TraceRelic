// These goldens are byte-exact on purpose. A checkpoint saves the parser state as JSON text, and the scanner
// compares and hashes that text. Message, call and interval IDs are SHA-256 digests of JSON text. Thus the
// key order of each saved or hashed object is part of the behavior, and a deep-equal check cannot see it.
// When a source has more than one batch, TranscriptCursor.decode prepares a lookahead with all the batches before it
// decodes the first one. The lookahead can give a message a native ID. Thus the main batches are pinned with and
// without the lookahead.
// To change a golden on purpose: set its text to '' in test/fixtures/codex-parser-golden-text.ts, run
// `bun run build` and `node --test apps/collector/dist/test/unit/providers/codex/codex-parser-golden.test.js`, review the
// actual text that the failure shows, and paste it as the new golden.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexSessionParser } from "#src/providers/codex/codex-session-parser";
import { CodexParserGoldenFixture as F } from "../../../fixtures/codex-parser-golden-fixture.ts";
import { CodexParserGolden as G } from "../../../fixtures/codex-parser-golden-text.ts";
import { ParserGolden } from "../../../fixtures/parser-golden-fixture.ts";

const main = new ParserGolden(CodexSessionParser, F.batches, G.main);
const mainWithLookahead = new ParserGolden(CodexSessionParser, F.batches, G.mainWithLookahead);
const fork = new ParserGolden(CodexSessionParser.forFork(F.forkPlan, F.forkedAt), F.forkBatches, G.fork);
const [first] = F.batches;

test("one Codex parser reads each batch with the golden output and saved state", t => main.assertOneScan(t));

test("a Codex parser restored from each golden state reads the next batch byte for byte", t => main.assertRestoredScans(t));

test("one Codex parser with the lookahead of a real scan reads each batch with the golden output and saved state", t =>
  mainWithLookahead.assertOneScan(t, async parser => {
    const fresh = JSON.stringify(parser.snapshot());
    // TranscriptCursor.decode gives the first batch, the later batches, the accepted line and the damaged lines.
    await parser.prepareLookahead(first.entries, F.lookaheadTail(), 0, first.damagedLines);
    assert.equal(JSON.stringify(parser.snapshot()), fresh);
  }));

test("one Codex fork parser reads each batch with the golden output and saved state", t => fork.assertOneScan(t));

test("a Codex fork parser restored from each golden state reads the next batch byte for byte", t => fork.assertRestoredScans(t));

test("a Codex parser awaits a new counter baseline only after the damaged line", () => {
  const parser = CodexSessionParser.resume();
  assert.deepEqual(F.batches.map(({ entries, damagedLines }) => {
    parser.decodeBatch(entries, damagedLines);
    return parser.awaitingBaseline;
  }), [false, false, false, true, false]);
});
