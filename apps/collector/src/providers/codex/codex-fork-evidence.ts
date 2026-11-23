import type { CodexRolloutEntry, CodexRolloutSource } from "../index.ts";
import type { DamagedLine, ReadPosition, RecordBatch } from "../../transcript/index.ts";
import { recordedInstant } from "@tracerelic/shared";
import type { CodexForkCheckpoint, TokenCounts } from "../../storage/collector-storage.ts";
import { jsonDigest } from "../../scan/parser-state.ts";
import { CodexForkTurn } from "./codex-fork-usage.ts";
import { breakdowns, object, providerCounts, sameTotals } from "./codex-token-counts.ts";
import { type CallContext, type Fields, initialHistory, readReport, reportContext } from "./codex-usage-report.ts";

type Source = CodexRolloutSource;
type Entry = CodexRolloutEntry & { startOffset: number; afterBlankPrefix?: true };

interface Report {
  first: ReadPosition;
  through: ReadPosition;
  signature?: string;
  cumulative?: TokenCounts;
  last?: TokenCounts;
  providerId?: string;
  turnId?: string;
  live: boolean;
  fresh: boolean;
  ownCallOnly: boolean;
  ownerThread?: string;
}

type Unresolved = "insufficient" | "contradicted";
type Assessment = { fork: CodexForkCheckpoint; contradicted: boolean };

type Instant = NonNullable<ReturnType<typeof recordedInstant>>;

function later(left: Instant, right: Instant): boolean {
  return left.second > right.second || (left.second === right.second && left.fraction > right.fraction);
}

function reportAt(entry: Entry, payload: Fields, context: CallContext, turn: CodexForkTurn): Report | undefined {
  const report = readReport(entry, payload, context, "");
  if (report === undefined) return;
  const location = {
    first: { offset: entry.startOffset, lineNumber: entry.lineNumber },
    through: { offset: entry.endOffset, lineNumber: entry.lineNumber },
  };
  const info = object(payload.info);
  const rawLast = entry.record.type === "token_usage_record" ? payload.usage : info?.last_token_usage;
  const last = providerCounts(rawLast);
  const live = report?.ownerThread ? report.ownerThread === entry.sessionId : turn.owns(report?.turnId);
  if (!report || report.invalidTotal || (rawLast !== undefined && rawLast !== null && !last)) {
    return { ...location, live, fresh: false, ownCallOnly: false };
  }
  const end = report.end;
  const signature = jsonDigest([end, last, report.providerId, report.turnId]);
  const fresh = !!end && ((!end.inputTokens && !end.outputTokens) || (!!last && report.independent && sameTotals(end, last)));
  return { ...location, signature, cumulative: end, last, providerId: report.providerId, turnId: report.turnId,
    live, fresh, ownerThread: report.ownerThread, ownCallOnly: !end && live && report.independent && !!report.last };
}

function countsDisagree(left?: TokenCounts, right?: TokenCounts): boolean {
  return !!left && !!right && (!sameTotals(left, right)
    || breakdowns.some(key => left[key] !== undefined && right[key] !== undefined && left[key] !== right[key]));
}

function disagree(left: Report, right: Report): boolean {
  return (!!left.providerId && !!right.providerId && left.providerId !== right.providerId)
    || (!!left.turnId && !!right.turnId && left.turnId !== right.turnId)
    || countsDisagree(left.cumulative, right.cumulative) || countsDisagree(left.last, right.last);
}

class ForkCapture {
  readonly reports: Report[] = [];
  header?: ReadPosition;
  firstUncertain?: ReadPosition;
  damagedAt?: number;
  complete = false;
  private context: CallContext = {};
  private readonly turn: CodexForkTurn;
  private sawHeader = false;

  private constructor(private readonly source: Source, private readonly options: {
    cutoff?: Instant; limit?: number; findUncertain?: true;
  }) {
    this.turn = new CodexForkTurn(source.codexForkHeader?.forkedAt);
  }

  static async read(source: Source, options: { cutoff?: Instant; limit?: number; findUncertain?: true }) {
    const capture = new ForkCapture(source, options);
    let end = 0;
    for await (const batch of source.readBatches({ offset: 0, lineNumber: 0 })) {
      if (capture.readBatch(batch)) return capture;
      end = batch.next.offset;
    }
    capture.complete = end === source.fileSize;
    return capture;
  }

  private damage({ lineNumber, startOffset }: DamagedLine): void {
    this.damagedAt ??= lineNumber;
    this.firstUncertain ??= { offset: startOffset, lineNumber };
    this.turn.interrupt();
  }

  private readBatch(batch: RecordBatch<CodexRolloutEntry>): boolean {
    const damaged = batch.damagedLines ?? [];
    let index = 0;
    for (const entry of batch.entries) {
      while (index < damaged.length && damaged[index].lineNumber < entry.lineNumber) {
        this.damage(damaged[index++]);
        if (this.options.findUncertain) return true;
      }
      if (this.readEntry(entry)) return true;
    }
    if (index < damaged.length) this.damage(damaged[index]);
    return this.options.findUncertain === true && this.firstUncertain !== undefined;
  }

  private readHeader(entry: Entry, payload: Fields): void {
    if (this.sawHeader || entry.record.type !== "session_meta") return;
    this.sawHeader = true;
    if ((payload.id ?? payload.session_id) !== this.source.sessionId || (entry.lineNumber !== 1 && !entry.afterBlankPrefix)
      || (entry.record.ordinal ?? 0) !== 0 || (payload.ordinal ?? 0) !== 0) return;
    if (!this.source.codexForkHeader && !initialHistory(entry, payload).startsWith("verified:")) return;
    const created = recordedInstant(typeof payload.timestamp === "string" ? payload.timestamp : entry.timestamp);
    const { cutoff } = this.options;
    if (cutoff && (!created || later(created, cutoff))) return;
    this.header = { offset: entry.endOffset, lineNumber: entry.lineNumber };
  }

  private readEntry(entry: Entry): boolean {
    const payload = object(entry.record.payload);
    if (!payload) return false;
    this.readHeader(entry, payload);
    if (this.options.limit === 0 && this.sawHeader) return true;
    this.turn.observe(entry, payload);
    this.context = reportContext(entry, payload, this.context, true);
    if (entry.record.type !== "token_usage_record" && (entry.record.type !== "event_msg" || payload.type !== "token_count")) return false;
    const report = reportAt(entry, payload, this.context, this.turn);
    if (!report) return false;
    const { cutoff } = this.options;
    if (cutoff) {
      const at = recordedInstant(entry.timestamp);
      if (at && later(at, cutoff)) {
        this.complete = true;
        return true;
      }
      if (!at) report.signature = undefined;
    }
    return this.keepReport(report);
  }

  private keepReport(report: Report): boolean {
    const { findUncertain, limit } = this.options;
    if (!report.ownCallOnly && !report.ownerThread) this.firstUncertain ??= report.first;
    if (findUncertain) return this.firstUncertain !== undefined;
    const first = this.reports[0];
    if (first?.ownCallOnly && limit !== undefined) {
      // The same native request can publish its own last-call amount before it
      // publishes the first cumulative counter. It still accounts for one call.
      const sameCall = report.live && first.providerId === report.providerId && first.turnId === report.turnId
        && !countsDisagree(first.last, report.last);
      if (sameCall && report.ownCallOnly) return false;
      first.fresh = sameCall && !!first.last && !!report.cumulative && !countsDisagree(first.last, report.cumulative)
        && this.damagedAt === undefined;
      this.reports.push(report);
      return true;
    }
    this.reports.push(report);
    return this.reports.length === limit && (first !== undefined || !report.ownCallOnly);
  }
}

function decision(child: ForkCapture, parent: ForkCapture, parentSessionId: string): CodexForkCheckpoint | Unresolved {
  if (!child.header) return "insufficient";
  const copied = parent.reports;
  let inheritedThrough = child.header;
  let baseline: TokenCounts | undefined = { inputTokens: 0, outputTokens: 0 };
  for (const [i, from] of copied.entries()) {
    const to = child.reports[i];
    if (!to?.signature || (child.damagedAt && child.damagedAt <= to.through.lineNumber)) return "insufficient";
    if (to.live || from.signature !== to.signature) {
      // A marker in a live child turn can prove the fork was taken before the
      // parent's remaining pre-fork work. Mere disagreement cannot prove this.
      if (!to.live) return disagree(from, to) ? "contradicted" : "insufficient";
      if (i === 0 && !to.fresh) return "insufficient";
      break;
    }
    inheritedThrough = to.through;
    // Without a cumulative report at this boundary, the child has no verified
    // starting counter. Its next identifiable call can still be measured.
    baseline = from.cumulative;
  }
  return { parentSessionId, inheritedThrough, ...(baseline && { baseline }) };
}

export class CodexForkEvidence {
  private readonly sessions = new Map<string, Source[]>();

  constructor(sources: readonly Source[]) {
    for (const source of sources) {
      const copies = this.sessions.get(source.sessionId) ?? [];
      copies.push(source);
      this.sessions.set(source.sessionId, copies);
    }
  }

  private async lineage(source: Source, parent: string): Promise<"selected" | Unresolved> {
    const visited = new Set([source.sessionId]);
    let id: string | undefined = parent;
    while (id !== undefined) {
      if (visited.has(id)) return "contradicted";
      visited.add(id);
      const copies = this.sessions.get(id);
      if (!copies?.length) return "insufficient";
      const next: string | undefined = copies[0].codexForkHeader?.parentSessionId;
      if (copies.some(copy => copy.codexForkHeader?.parentSessionId !== next)) return "contradicted";
      if (id !== parent && !next) {
        for (const copy of copies) {
          if (!(await ForkCapture.read(copy, { limit: 0 })).header) return "insufficient";
        }
      }
      id = next;
    }
    return "selected";
  }

  async assess(source: Source): Promise<Assessment | undefined> {
    const header = source.codexForkHeader;
    if (!header) return;
    const { parentSessionId } = header;
    const fork = recordedInstant(header.forkedAt);
    const lineage = await this.lineage(source, parentSessionId);
    const prefix = lineage === "selected" ? (fork ? await this.parentPrefix(parentSessionId, fork) : "insufficient") : lineage;
    const parent = typeof prefix === "string" ? undefined : prefix;
    // Once all eligible parent reports have been compared, the child's subsequent
    // messages and reports belong to the ordinary scanner.
    let child = await ForkCapture.read(source, parent ? { limit: Math.max(1, parent.reports.length) } : { findUncertain: true });
    const match = typeof prefix === "string" ? prefix : decision(child, prefix, parentSessionId);
    if (typeof match !== "string") return { fork: match, contradicted: false };
    // A mismatching prefix can start with safe child calls. Locate the first
    // disputed row even when it falls beyond the number of candidate parent rows.
    if (parent && !child.complete && !child.firstUncertain) child = await ForkCapture.read(source, { findUncertain: true });
    const { firstUncertain } = child;
    return { fork: { parentSessionId, ...(firstUncertain && { firstUncertain }) }, contradicted: match === "contradicted" };
  }

  private async parentPrefix(parentSessionId: string, fork: Instant): Promise<ForkCapture | Unresolved> {
    let agreed: ForkCapture | undefined;
    let incomplete = false;
    for (const copy of this.sessions.get(parentSessionId) ?? []) {
      const parent = await ForkCapture.read(copy, { cutoff: fork });
      if (!parent.header || parent.damagedAt || !parent.complete || parent.reports.some(row => !row.signature)) {
        incomplete = true;
        continue;
      }
      if (copy.codexForkHeader && !parent.reports.length) {
        const origin = await this.emptyOrigin(copy.codexForkHeader);
        if (origin === "contradicted") return origin;
        if (origin === "insufficient") incomplete = true;
      }
      if (agreed) {
        const common = Math.min(agreed.reports.length, parent.reports.length);
        for (let i = 0; i < common; i++) {
          if (disagree(agreed.reports[i], parent.reports[i])) return "contradicted";
          if (agreed.reports[i].signature !== parent.reports[i].signature) incomplete = true;
        }
      }
      if (!agreed || parent.reports.length > agreed.reports.length) agreed = parent;
    }
    return !incomplete && agreed ? agreed : "insufficient";
  }

  private async emptyOrigin(header: NonNullable<Source["codexForkHeader"]>): Promise<"empty" | Unresolved> {
    // A fork header alone carries no starting counter. Follow the selected
    // parent at this earlier fork time, independently of the grandchild's cut.
    const cutoff = recordedInstant(header.forkedAt);
    if (!cutoff) return "insufficient";
    const ancestor = await this.parentPrefix(header.parentSessionId, cutoff);
    if (typeof ancestor === "string") return ancestor;
    const measured = ancestor.reports.some(report => [report.cumulative, report.last]
      .some(amount => amount && (amount.inputTokens > 0 || amount.outputTokens > 0)));
    return measured ? "insufficient" : "empty";
  }
}
