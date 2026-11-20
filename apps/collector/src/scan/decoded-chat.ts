import type { DamagedLine, RecordBatch } from "../history/index.ts";
import type {
  BranchObservation, ClaudeUsageReport, Message, Metadata, Usage, UsageAnchor, UsageDiagnostic, UsageWindow,
} from "../storage/collector-storage.ts";

type PositionedMessage = Message & { sourceOrder: number; blockIndex: number };

export interface DecodedUsage {
  usage: Usage[];
  usageAnchors?: UsageAnchor[];
  usageWindows: UsageWindow[];
  claudeUsageReports?: ClaudeUsageReport[];
  usageDiagnostics?: UsageDiagnostic[];
  hasGap: boolean;
}

export interface DecodedChat extends Partial<DecodedUsage> {
  messages: PositionedMessage[];
  metadata: Metadata;
  branchObservation?: BranchObservation;
}

export interface ChatParser<Entry> {
  readonly awaitingBaseline?: boolean;
  prepareLookahead?(first: readonly Entry[], tail: AsyncIterable<RecordBatch<Entry>>, acceptedLine: number): Promise<void>;
  decodeBatch(entries: readonly Entry[], damagedLines?: readonly DamagedLine[]): DecodedChat;
  snapshot(): object;
}
