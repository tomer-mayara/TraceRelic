// These goldens are byte-exact on purpose. A checkpoint saves the parser state as JSON text, and the scanner
// compares and hashes that text. Fallback message IDs are SHA-256 digests of JSON text. Thus the key order of
// each saved or hashed object is part of the behavior, and a deep-equal check cannot see it.
// To change a golden on purpose: set its text to '' in test/fixtures/claude-parser-golden-text.ts, run
// `bun run build` and `node --test apps/collector/dist/test/unit/providers/claude/claude-parser-golden.test.js`, review the
// actual text that the failure shows, and paste it as the new golden.
import { test } from "node:test";
import { ClaudeSessionParser } from "#src/providers/claude/claude-session-parser";
import { ClaudeParserGoldenFixture as F } from "../../../fixtures/claude-parser-golden-fixture.ts";
import { ClaudeParserGolden as G } from "../../../fixtures/claude-parser-golden-text.ts";
import { ParserGolden } from "../../../fixtures/parser-golden-fixture.ts";

const subagent = new ParserGolden(ClaudeSessionParser.forSource(false, F.subagent), F.subagentBatches, G.subagent);
const earlierCopy = new ParserGolden(ClaudeSessionParser.forSource(true), F.earlierCopyBatches, G.earlierCopy);

test("one Claude subagent parser reads each batch with the golden output and saved state", t => subagent.assertOneScan(t));

test("a Claude subagent parser restored from each golden state reads the next batch byte for byte",
  t => subagent.assertRestoredScans(t));

test("one parser for an earlier Claude copy reads each batch with the golden output and saved state", t => earlierCopy.assertOneScan(t));

test("a parser for an earlier Claude copy restored from each golden state reads the next batch byte for byte",
  t => earlierCopy.assertRestoredScans(t));
