import type { Metadata, SessionView } from "@tracerelic/collector/storage";
import type { ScanSelection, SourceDiscoveryOptions, TranscriptSource } from "@tracerelic/collector/transcript";
import type { EarlierCopy } from "#src/scan/scan-provider";

/** The fields of a source. A source needs only its session ID and its file. */
type SourceFields = Pick<TranscriptSource<unknown>, "sessionId" | "sourceFile">
  & Partial<Omit<TranscriptSource<unknown>, "completeEnd" | "prefixDigests" | "readBatches">>;

/** One call of discoverSources. */
export interface DiscoveryCall {
  readonly selection: ScanSelection;
  readonly options: SourceDiscoveryOptions;
}

/** Values that the unit tests of a scan pass give to the pass. */
export class ScanPassFixture {
  /** A source with these fields and no records. A provider test adds the fields of its own source type. */
  static source<Entry>(fields: SourceFields): TranscriptSource<Entry> {
    return {
      fileSize: 0, ...fields,
      completeEnd: async () => 0,
      prefixDigests: async () => [],
      readBatches: async function* () {},
    };
  }

  /** A stored Claude Code session that has only these metadata fields. */
  static storedSession(metadata: Metadata): SessionView {
    return { key: { harness: "claude", sessionId: "chat" }, metadata, messages: [], usage: [], coverage: "unknown", observedTotalTokens: null };
  }
}

/**
 * A stand-in for the history class that a scan pass reads. Each call of discoverSources gives the next
 * list of sources and records the call.
 */
export class ProviderHistoryStub<Source> {
  readonly calls: DiscoveryCall[] = [];
  /** The number of sources that the discoveries started to give. */
  requested = 0;

  constructor(readonly root: string, private readonly discoveries: readonly (readonly Source[])[] = []) {}

  discoverSources(selection: ScanSelection = {}, options: SourceDiscoveryOptions = {}): AsyncGenerator<Source> {
    const sources = this.discoveries[this.calls.length] ?? [];
    this.calls.push({ selection, options });
    return this.serve(sources);
  }

  async confirmedAbsent(paths: readonly string[]): Promise<string[]> {
    return [...paths];
  }

  async *identitiesAt(): AsyncGenerator<{ path: string; sessionId: string }> {}

  async *recoveryCandidates(): AsyncGenerator<EarlierCopy<Source>, void, unknown> {}

  private async *serve(sources: readonly Source[]): AsyncGenerator<Source> {
    for (const source of sources) {
      this.requested++;
      yield source;
    }
  }
}
