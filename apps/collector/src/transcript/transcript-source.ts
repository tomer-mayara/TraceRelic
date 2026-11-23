import type { LocalHistoryEntry } from "../history/history-provider.ts";
import type { CapturedTranscriptFile, TranscriptChangedError } from "./captured-transcript-file.ts";

export interface ScanSelection {
  readonly sessionIds?: readonly string[];
  readonly projectPaths?: readonly string[];
}

export interface SourceDiscoveryOptions {
  sourceFile?: string;
  onChanged?: (error: TranscriptChangedError) => void;
}

export interface TranscriptEntry<Harness extends LocalHistoryEntry["harness"]> extends Omit<LocalHistoryEntry, "timestamp" | "harness"> {
  readonly harness: Harness;
  readonly timestamp?: string;
  readonly endOffset: number;
  readonly recordPrefixDigest?: string;
}

export interface Transcript<Entry> {
  readonly sessionId: string;
  readonly sourceFile: string;
  readonly endOffset: number;
  readonly entries: readonly Entry[];
}

export interface ReadPosition {
  readonly offset: number;
  readonly lineNumber: number;
}

export interface DamagedLine {
  readonly lineNumber: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface BatchRecords<Entry> {
  entries: (Entry & { readonly startOffset: number; readonly afterBlankPrefix?: true })[];
  damagedLines?: DamagedLine[];
}

export interface RecordBatch<Entry> extends Readonly<BatchRecords<Entry>> {
  readonly next: ReadPosition;
  readonly prefixDigest: string;
}

export interface VerifiedPrefix {
  readonly offset: number;
  readonly prefixDigest: string;
}

/** One session in one captured file. It has no provider field. Each provider declares its own source type. */
interface TranscriptSourceInfo {
  readonly sessionId: string;
  readonly sourceFile: string;
  readonly fileSize: number;
}

export interface TranscriptSource<Entry> extends TranscriptSourceInfo {
  completeEnd(): Promise<number>;
  prefixDigests(offsets: readonly number[]): Promise<readonly VerifiedPrefix[]>;
  readBatches(position: ReadPosition, maxBatchBytes?: number, endOffset?: number): AsyncIterable<RecordBatch<Entry>>;
}

export interface DecodedRecord extends Pick<LocalHistoryEntry, "lineNumber" | "record"> {
  readonly endOffset: number;
  readonly afterBlankPrefix?: true;
}

export interface SelectedFile<H extends LocalHistoryEntry["harness"]> {
  readonly sessionId: string;
  readonly file: CapturedTranscriptFile;
  readonly harness: H;
  readonly blankPrefixHeaderEnd?: number;
  matches(record: LocalHistoryEntry["record"], lineNumber: number): boolean;
  /** True for a conversation record. Each one gets the digest of the file through its own line. */
  isConversation(record: LocalHistoryEntry["record"]): boolean;
}
