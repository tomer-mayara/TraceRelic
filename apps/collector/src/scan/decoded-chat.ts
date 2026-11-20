import type { RecordBatch } from "../history/index.ts";
import type { BranchObservation, Message, Metadata, Usage, UsageAnchor, UsageWindow } from "../storage/collector-storage.ts";

type PositionedMessage = Message & { sourceOrder: number; blockIndex: number };

export interface DecodedUsage {
  usage: Usage[];
  usageAnchors?: UsageAnchor[];
  usageWindows: UsageWindow[];
  hasGap: boolean;
}

export interface DecodedChat extends Partial<DecodedUsage> {
  messages: PositionedMessage[];
  metadata: Metadata;
  branchObservation?: BranchObservation;
}

export interface ChatParser<Entry> {
  prepareLookahead?(first: readonly Entry[], tail: AsyncIterable<RecordBatch<Entry>>, acceptedLine: number): Promise<void>;
  decodeBatch(entries: readonly Entry[]): DecodedChat;
  snapshot(): object;
}
