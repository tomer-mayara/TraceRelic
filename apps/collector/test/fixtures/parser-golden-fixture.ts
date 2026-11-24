import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { TestContext } from "node:test";

type Fields = Readonly<Record<string, unknown>>;

/** A JSON record, or the raw text of a damaged line that the reader cannot decode. */
export type GoldenLine = Fields | string;

/** The position of a line in the file. The history reader reports a damaged line with this position. */
export interface GoldenDamage {
  readonly lineNumber: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

interface GoldenSource<Harness extends string> {
  readonly harness: Harness;
  readonly sessionId: string;
  readonly sourceFile: string;
}

interface GoldenEntry<Harness extends string> extends GoldenSource<Harness>, GoldenDamage {
  readonly timestamp?: string;
  readonly record: Fields;
  readonly recordPrefixDigest?: string;
}

export interface GoldenBatch<Entry, Damage> {
  readonly entries: readonly Entry[];
  readonly damagedLines?: readonly Damage[];
}

export interface GoldenText {
  /** The JSON text of the decoded batch. */
  readonly output: string;
  /** The JSON text of the decoded batch from a parser restored from the previous state, when it differs from `output`. */
  readonly restoredOutput?: string;
  /** The JSON text of the parser state after the batch. */
  readonly state: string;
  /** The state text of a parser restored from `state`, before it reads more lines, when it differs from `state`. */
  readonly stateAfterRestore?: string;
  /** The state after the batch from a parser restored from the previous state, when it differs from `state`. */
  readonly restoredState?: string;
}

interface GoldenParser<Entry, Damage> {
  decodeBatch(entries: readonly Entry[], damagedLines?: readonly Damage[]): object;
  snapshot(): object;
}

interface GoldenFormat<Parser> {
  resume(state?: unknown): Parser;
}

// The history reader supplies a prefix digest only for these record types.
const digestedTypes = new Set(["response_item", "event_msg", "user", "assistant"]);

/**
 * Gives fixed lines the positions and prefix digests that the history reader gives to one JSONL file.
 * Each batch also has the reader's `next` position and the prefix digest at its end.
 */
export class GoldenTranscript {
  static batches<Harness extends string>(source: GoldenSource<Harness>, groups: readonly (readonly GoldenLine[])[]) {
    const prefix = createHash("sha256");
    let lineNumber = 0;
    let endOffset = 0;
    return groups.map(lines => {
      const entries: GoldenEntry<Harness>[] = [];
      const damagedLines: GoldenDamage[] = [];
      for (const line of lines) {
        const text = typeof line === "string" ? line : JSON.stringify(line);
        const startOffset = endOffset;
        endOffset += Buffer.byteLength(text) + 1;
        prefix.update(`${text}\n`);
        const position = { lineNumber: ++lineNumber, startOffset, endOffset };
        if (typeof line === "string") damagedLines.push(position);
        else entries.push({ ...source, ...position, record: line,
          ...(typeof line.timestamp === "string" && { timestamp: line.timestamp }),
          ...(digestedTypes.has(String(line.type)) && { recordPrefixDigest: prefix.copy().digest("hex") }) });
      }
      return { entries, ...(damagedLines.length > 0 && { damagedLines }),
        next: { offset: endOffset, lineNumber }, prefixDigest: prefix.copy().digest("hex") };
    });
  }
}

/** Compares a parser with golden texts. Each batch is a subtest, so that a failure names its batch. */
export class ParserGolden<Entry, Damage, Parser extends GoldenParser<Entry, Damage> = GoldenParser<Entry, Damage>> {
  constructor(
    private readonly format: GoldenFormat<Parser>,
    private readonly batches: readonly GoldenBatch<Entry, Damage>[],
    private readonly texts: readonly GoldenText[],
  ) {}

  /** One parser reads every batch, as during one scan. An optional `prepare` step runs before the first batch. */
  async assertOneScan(t: TestContext, prepare?: (parser: Parser) => Promise<void>): Promise<void> {
    assert.equal(this.texts.length, this.batches.length);
    const parser = this.format.resume();
    if (prepare) await prepare(parser);
    for (const [index, { entries, damagedLines }] of this.batches.entries()) {
      await t.test(`batch ${index + 1}`, () => {
        ParserGolden.assertText(JSON.stringify(parser.decodeBatch(entries, damagedLines)), this.texts[index].output);
        ParserGolden.assertText(JSON.stringify(parser.snapshot()), this.texts[index].state);
      });
    }
  }

  /** A parser restored from the golden state of each batch reads the next batch, as a later scan does. */
  async assertRestoredScans(t: TestContext): Promise<void> {
    assert.equal(this.texts.length, this.batches.length);
    for (const [index, { entries, damagedLines }] of this.batches.entries()) {
      if (index === 0) continue;
      const saved = this.texts[index - 1];
      const { output, restoredOutput, state, restoredState } = this.texts[index];
      await t.test(`batch ${index + 1} after the state of batch ${index}`, () => {
        const parser = this.format.resume(JSON.parse(saved.state));
        ParserGolden.assertText(JSON.stringify(parser.snapshot()), saved.stateAfterRestore ?? saved.state);
        ParserGolden.assertText(JSON.stringify(parser.decodeBatch(entries, damagedLines)), restoredOutput ?? output);
        ParserGolden.assertText(JSON.stringify(parser.snapshot()), restoredState ?? state);
      });
    }
  }

  /** A content change shows as a structured diff. The exact text check then also covers the key order. */
  static assertText(actual: string, golden: string): void {
    // An empty golden skips the content check, so that the failure shows the full actual text.
    if (golden) assert.deepEqual(JSON.parse(actual), JSON.parse(golden));
    assert.equal(actual, golden);
  }
}
