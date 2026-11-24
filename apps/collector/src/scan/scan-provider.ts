import type { ScanSelection, SourceDiscoveryOptions, TranscriptSource } from "../transcript/index.ts";
import type {
  AcknowledgedSource, Checkpoint, CollectorStorage, Harness, SourceLocation, SourceScope, StreamKey,
} from "../storage/collector-storage.ts";
import type { SourceSighting } from "./source-sightings.ts";
import type { ParserFormat, SourceLine } from "./transcript-cursor.ts";

/** Where a source is, and its stream ID for a collector that has no installation ID. */
export interface LocatedSource {
  readonly location: SourceLocation;
  /** The stream ID that contains the provider root. With an installation ID, the stream ID is location.path. */
  readonly rootStreamId: string;
}

/** A source that a pass captured, with its sighting. */
export interface SeenSource<Source> { sighting: SourceSighting; transcript: Source }

/** What a provider receives to check the identity of the acknowledged sources that a pass did not see. */
export interface IdentityInventory<Source> {
  readonly storage: CollectorStorage;
  readonly scope: SourceScope;
  readonly known: ReadonlyMap<string, AcknowledgedSource>;
  /** The sources that the pass captured. Read them one time. */
  readonly seen: Iterable<SeenSource<Source>>;
}

/** One earlier copy of a current file, with each readable session in it. */
export interface EarlierCopy<Source> { currentPath: string; path: string; sources: Source[] }
interface CopyCandidate<Source> { transcript: Source; path: string }
export interface CopyAssessment<Source> { excluded: string[]; candidates: CopyCandidate<Source>[] }

/** A named earlier file can resume the logical current stream only from verified bytes. */
export interface SourceCopy<Entry, Source> {
  verify(checkpoint: Checkpoint | null): Promise<Map<number, string> | undefined>;
  current(location: SourceLocation): Source;
  format(): ParserFormat<Entry>;
}

export interface EarlierCopies<Entry, Source> {
  candidates(paths: ReadonlySet<string>): AsyncIterable<EarlierCopy<Source>>;
  assess(row: AcknowledgedSource, checkpoint: Checkpoint | null, copies: EarlierCopy<Source>[]): Promise<CopyAssessment<Source>>;
  unreadable(error: unknown): boolean;
  open(copy: Source): SourceCopy<Entry, Source>;
}

/** One scan pass of one provider over the selected files. The pass keeps its own state. */
export interface ProviderScan<Entry extends SourceLine = SourceLine, Source extends TranscriptSource<Entry> = TranscriptSource<Entry>> {
  /** Sources that share one physical file arrive together. With sourceFile, discover that file again. */
  discoverFiles(options: SourceDiscoveryOptions): AsyncIterable<readonly Source[]>;
  /** The name that the physical forms of one file share. Absent when each file has one form. */
  logicalName?(sourceFile: string): string;
  parserFor(source: Source, checkpoint: Checkpoint | null): ParserFormat<Entry> | Promise<ParserFormat<Entry>>;
  locate(source: Source): LocatedSource;
  confirmedAbsent(paths: readonly string[], excludedCopyPaths?: readonly string[]): Promise<readonly string[]>;
  /** Check the identity of the acknowledged sources that this pass did not see. Return the sources to select. */
  repairIdentities?(inventory: IdentityInventory<Source>): Promise<readonly StreamKey[]>;
  /** Only a provider that keeps earlier copies of a file has this. */
  readonly earlierCopies?: EarlierCopies<Entry, Source>;
}

/** The local transcripts of one provider, as the scanner uses them. */
export interface ScanProvider<Entry extends SourceLine = SourceLine, Source extends TranscriptSource<Entry> = TranscriptSource<Entry>> {
  readonly harness: Harness;
  readonly root: string;
  /** Open one pass over the selected files. */
  openScan(selection: ScanSelection): ProviderScan<Entry, Source>;
}
