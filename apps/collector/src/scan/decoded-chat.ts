import type { DamagedLine, RecordBatch } from "../transcript/index.ts";
import type {
  BranchObservation, ClaudeUsageReport, CodexCallAlias, CodexCallClaim, Message, Metadata, Usage, UsageAnchor, UsageDiagnostic, UsageWindow,
} from "../storage/collector-storage.ts";

type PositionedMessage = Message & { sourceOrder: number; blockIndex: number };

export interface DecodedUsage {
  usage: Usage[];
  usageAnchors?: UsageAnchor[];
  usageWindows: UsageWindow[];
  claudeUsageReports?: ClaudeUsageReport[];
  codexCallClaims?: CodexCallClaim[];
  codexCallAliases?: CodexCallAlias[];
  usageDiagnostics?: UsageDiagnostic[];
  hasGap: boolean;
}

export interface DecodedChat extends Partial<DecodedUsage> {
  messages: PositionedMessage[];
  messageOrigins?: { sourceOrder: number; prefixDigest: string; refinesAccepted?: true }[];
  metadata: Metadata;
  branchObservation?: BranchObservation;
}

export interface ChatParser<Entry> {
  readonly awaitingBaseline?: boolean;
  prepareLookahead?(first: readonly Entry[], tail: AsyncIterable<RecordBatch<Entry>>, acceptedLine: number, damage?: readonly DamagedLine[]): Promise<void>;
  decodeBatch(entries: readonly Entry[], damagedLines?: readonly DamagedLine[]): DecodedChat;
  snapshot(): object;
}
