import { createHash } from "node:crypto";
import { relative } from "node:path";
import type {
  ChatParser, DecodedChat, IdentityInventory, LocatedSource, ParserFormat, ProviderCheckpointFields, ProviderScan, ScanProvider,
  UsageCorrection,
} from "@tracerelic/collector/scan";
import type { Checkpoint, Harness, SessionView, StreamKey } from "@tracerelic/collector/storage";
import type {
  ReadPosition, RecordBatch, ScanSelection, SourceDiscoveryOptions, TranscriptSource, VerifiedPrefix,
} from "@tracerelic/collector/transcript";

const at = "2026-02-01T12:00:00Z";

/** One record of the mock format: one JSON line with one text. */
interface MockEntry {
  readonly lineNumber: number;
  readonly endOffset: number;
  readonly text: string;
}

/** One session in an in-memory JSONL file. Each line is a JSON object with one text. */
export class MockTranscript implements TranscriptSource<MockEntry> {
  readonly fileSize: number;
  private readonly bytes: Buffer;
  private readonly lines: (MockEntry & { readonly startOffset: number })[] = [];

  constructor(readonly sourceFile: string, readonly sessionId: string, texts: readonly string[]) {
    const rows = texts.map(text => JSON.stringify({ text }) + "\n");
    this.bytes = Buffer.from(rows.join(""));
    this.fileSize = this.bytes.length;
    let startOffset = 0;
    for (const [index, text] of texts.entries()) {
      const endOffset = startOffset + Buffer.byteLength(rows[index]);
      this.lines.push({ lineNumber: index + 1, startOffset, endOffset, text });
      startOffset = endOffset;
    }
  }

  /** The last line ends with a newline. */
  async completeEnd(): Promise<number> {
    return this.fileSize;
  }

  async prefixDigests(offsets: readonly number[]): Promise<readonly VerifiedPrefix[]> {
    return offsets.map(offset => ({ offset, prefixDigest: this.digest(offset) }));
  }

  /** One batch for each line between the position and the end offset. */
  async *readBatches(position: ReadPosition, _maxBatchBytes?: number, endOffset = this.fileSize): AsyncGenerator<RecordBatch<MockEntry>> {
    for (const line of this.lines) {
      if (line.startOffset < position.offset || line.endOffset > endOffset) continue;
      yield { entries: [line], next: { offset: line.endOffset, lineNumber: line.lineNumber }, prefixDigest: this.digest(line.endOffset) };
    }
  }

  /** The SHA-256 digest of the bytes before the offset. */
  private digest(offset: number): string {
    return createHash("sha256").update(this.bytes.subarray(0, offset)).digest("hex");
  }
}

/** Decodes each entry as one user message. Its state is the number of decoded entries. */
class MockChatParser implements ChatParser<MockEntry> {
  constructor(private decoded: number) {}

  decodeBatch(entries: readonly MockEntry[]): DecodedChat {
    this.decoded += entries.length;
    return {
      messages: entries.map(({ lineNumber, text }) => ({ id: `mock:${lineNumber}`, at, role: "user", text, sourceOrder: lineNumber, blockIndex: 0 })),
      metadata: {},
    };
  }

  snapshot(): object {
    return { decoded: this.decoded };
  }
}

/** Adds one call of one input token for each entry that its parser decodes. */
class MockCallParser implements ChatParser<MockEntry> {
  constructor(private readonly parser: ChatParser<MockEntry>) {}

  decodeBatch(entries: readonly MockEntry[]): DecodedChat {
    const usage = entries.map(({ lineNumber }) => ({ id: `call:${lineNumber}`, revision: 1, at, inputTokens: 1, outputTokens: 0 }));
    return { ...this.parser.decodeBatch(entries), usage };
  }

  snapshot(): object {
    return this.parser.snapshot();
  }
}

/** The parser format of the mock provider. It adds no checkpoint fields and has no correction. */
export class MockFormat implements ParserFormat<MockEntry> {
  // Version 1 is the format of an earlier collector. The cursor reads such a source again from byte zero.
  readonly version = 2;

  resume(state?: unknown): ChatParser<MockEntry> {
    const decoded = typeof state === "object" && state !== null && "decoded" in state ? state.decoded : 0;
    return new MockChatParser(typeof decoded === "number" ? decoded : 0);
  }
}

/** The plan of a mock provider for an accepted checkpoint. Undefined when that checkpoint needs no correction. */
type MockCorrection = (accepted: Checkpoint) => UsageCorrection<MockEntry> | undefined;

/** The format of a provider that adds fields to each checkpoint and can correct the accepted usage. Each entry is also one call. */
export class CorrectingFormat extends MockFormat {
  constructor(readonly checkpointFields: ProviderCheckpointFields, private readonly plan: MockCorrection = () => undefined) {
    super();
  }

  resume(state?: unknown): ChatParser<MockEntry> {
    return new MockCallParser(super.resume(state));
  }

  correction(accepted: Checkpoint): UsageCorrection<MockEntry> | undefined {
    return this.plan(accepted);
  }
}

/** The format of a source that adds to the session of another file. It skips a batch when storage has each of its texts. */
export class PreparingFormat extends MockFormat {
  readonly prepared: { known: SessionView | null; expectedOffset: number; texts: string[] }[] = [];

  prepareBatch(chat: DecodedChat, known: SessionView | null, expectedOffset: number): boolean {
    const texts = chat.messages.map(message => message.text);
    this.prepared.push({ known, expectedOffset, texts });
    return !texts.every(text => known?.messages.some(message => message.text === text));
  }
}

/** What a mock provider gives the scanner. */
interface MockProviderSetup {
  readonly harness: Harness;
  readonly root: string;
  /** The groups of each discovery, in order. The sources of one group share one file. */
  readonly groups: readonly (readonly MockTranscript[])[];
  /** The format of each source. The default format has no prepareBatch. */
  readonly format?: ParserFormat<MockEntry>;
  /** True when each pass checks the identity of the acknowledged sources that it did not see. */
  readonly repairs?: boolean;
  /** Receives one line for each call, such as "discoverFiles /root". */
  readonly journal?: string[];
}

/**
 * A provider that is neither Codex nor Claude Code. It records each call of the scanner. Its passes have no logical name
 * and no earlier copies. Only a provider that is set up with repairs has identity repair.
 */
export class MockScanProvider implements ScanProvider<MockEntry, MockTranscript> {
  readonly harness: Harness;
  readonly root: string;
  readonly format: ParserFormat<MockEntry>;
  /** The selection of each pass. */
  readonly selections: ScanSelection[] = [];
  /** What each identity repair received. */
  readonly repairs: IdentityInventory<MockTranscript>[] = [];
  private readonly journal: string[];

  constructor(readonly setup: MockProviderSetup) {
    this.harness = setup.harness;
    this.root = setup.root;
    this.format = setup.format ?? new MockFormat();
    this.journal = setup.journal ?? [];
  }

  openScan(selection: ScanSelection): ProviderScan<MockEntry, MockTranscript> {
    this.record("openScan");
    this.selections.push(selection);
    return this.setup.repairs ? new RepairingScan(this) : new MockScan(this);
  }

  record(call: string): void {
    this.journal.push(`${call} ${this.root}`);
  }
}

/** One pass of a mock provider. */
class MockScan implements ProviderScan<MockEntry, MockTranscript> {
  constructor(protected readonly provider: MockScanProvider) {}

  async *discoverFiles({ sourceFile }: SourceDiscoveryOptions): AsyncGenerator<readonly MockTranscript[]> {
    this.provider.record("discoverFiles");
    for (const group of this.provider.setup.groups) if (!sourceFile || group[0].sourceFile === sourceFile) yield group;
  }

  parserFor(): ParserFormat<MockEntry> {
    this.provider.record("parserFor");
    return this.provider.format;
  }

  /** The path is relative to the root. The root-based stream ID names the source file. */
  locate(source: MockTranscript): LocatedSource {
    this.provider.record("locate");
    const { root } = this.provider;
    return { location: { root, path: relative(root, source.sourceFile) }, rootStreamId: "mock:" + source.sourceFile };
  }

  /** No file is absent. */
  async confirmedAbsent(): Promise<readonly string[]> {
    this.provider.record("confirmedAbsent");
    return [];
  }
}

/** A pass that checks the identity of the acknowledged sources that it did not see. It selects no source. */
class RepairingScan extends MockScan {
  async repairIdentities(inventory: IdentityInventory<MockTranscript>): Promise<readonly StreamKey[]> {
    this.provider.record("repairIdentities");
    this.provider.repairs.push({ ...inventory, known: new Map(inventory.known), seen: [...inventory.seen] });
    return [];
  }
}
