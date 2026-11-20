import type { BranchObservation, Message, Metadata } from "../storage/collector-storage.ts";

export type PositionedMessage = Message & { sourceOrder: number; blockIndex: number };

export interface DecodedChat {
  messages: PositionedMessage[];
  metadata: Metadata;
  branchObservation?: BranchObservation;
}
