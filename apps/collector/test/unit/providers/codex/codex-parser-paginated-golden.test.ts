// These goldens are byte-exact on purpose. A checkpoint saves the parser state as JSON text, and the scanner
// compares and hashes that text. Fallback message IDs are SHA-256 digests of JSON text, and paginated items build
// their blocks with another key order than legacy records. Thus the key order of each saved or hashed object is
// part of the behavior. To change a golden on purpose: set its text to '' in test/fixtures/codex-parser-paths-text.ts,
// run `bun run build` and `node --test apps/collector/dist/test/unit/providers/codex/codex-parser-paginated-golden.test.js`,
// review the actual text that the failure shows, and paste it as the new golden.
import { test } from "node:test";
import { CodexSessionParser } from "#src/providers/codex/codex-session-parser";
import { CodexParserPathsFixture as F } from "../../../fixtures/codex-parser-paths-fixture.ts";
import { CodexParserPathsGolden as G } from "../../../fixtures/codex-parser-paths-text.ts";
import { ParserGolden } from "../../../fixtures/parser-golden-fixture.ts";

const paginated = new ParserGolden(CodexSessionParser, F.paginated, G.paginated);

test("one Codex parser reads each paginated batch with the golden output and saved state", t => paginated.assertOneScan(t));

test("a Codex parser restored from each paginated golden state reads the next batch byte for byte",
  t => paginated.assertRestoredScans(t));
