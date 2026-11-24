// These byte-exact goldens pin three known differences between one scan and a scan that starts from a checkpoint.
// A restored Codex parser rebuilds some saved objects in a fixed key order. Thus its state text, and in two cases
// its output text, differ from one scan, but the content is the same. The scanner compares and hashes the state
// text, so these differences are behavior. Keep them as they are unless a separate decision changes them.
// To change a golden on purpose: set its text to '' in test/fixtures/codex-parser-paths-text.ts, run `bun run build`
// and `node --test apps/collector/dist/test/unit/providers/codex/codex-parser-restore-golden.test.js`, review the actual text
// that the failure shows, and paste it as the new golden.
import { test } from "node:test";
import { CodexSessionParser } from "#src/providers/codex/codex-session-parser";
import { CodexParserPathsFixture as F } from "../../../fixtures/codex-parser-paths-fixture.ts";
import { CodexParserPathsGolden as G } from "../../../fixtures/codex-parser-paths-text.ts";
import { ParserGolden } from "../../../fixtures/parser-golden-fixture.ts";

for (const [difference, batches, texts] of [
  ["a repeated counter snapshot adds a breakdown to the baseline", F.addedBreakdown, G.addedBreakdown],
  ["a joined assistant mirror is pending at the checkpoint", F.joinedMirror, G.joinedMirror],
  ["the chat context gains a remote after its branch", F.contextOrder, G.contextOrder],
] as const) {
  test(`known restore difference, kept as it is: ${difference}`, async t => {
    const golden = new ParserGolden(CodexSessionParser, batches, texts);
    await golden.assertOneScan(t);
    await golden.assertRestoredScans(t);
  });
}
