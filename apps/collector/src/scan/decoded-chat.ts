import type { RecordBatch } from "../history/index.ts";
import type { BranchObservation, Message, Metadata } from "../storage/collector-storage.ts";

type PositionedMessage = Message & { sourceOrder: number; blockIndex: number };

export interface DecodedChat {
  messages: PositionedMessage[];
  metadata: Metadata;
  branchObservation?: BranchObservation;
}

export interface ChatParser<Entry> {
  prepareLookahead?(first: readonly Entry[], tail: AsyncIterable<RecordBatch<Entry>>, acceptedLine: number): Promise<void>;
  decodeBatch(entries: readonly Entry[]): DecodedChat;
  snapshot(): object;
}
