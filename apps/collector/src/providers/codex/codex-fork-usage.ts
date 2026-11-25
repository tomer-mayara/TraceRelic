import { RecordedInstant } from "@tracerelic/shared";
import type { CodexForkCheckpoint } from "../../storage/collector-storage.ts";
import type { Fields } from "../../transcript/json-record.ts";
import { ParserState } from "../../scan/parser-state.ts";
import { CodexTokenCounts, zero } from "./codex-token-counts.ts";
import type { Report, UsageEntry } from "./codex-usage-report.ts";

/** Native events tie a turn to the child even when the parent is unavailable. */
export class CodexForkTurn {
  private ownTurn?: string;
  private readonly forkSecond: number;

  constructor(forkedAt?: string) {
    this.forkSecond = RecordedInstant.parse(forkedAt)?.second ?? NaN;
  }

  restore(turn: unknown): void {
    this.ownTurn = ParserState.string(turn);
  }

  snapshot(): string | undefined {
    return this.ownTurn;
  }

  owns(turnId: string | undefined): boolean {
    return !!this.ownTurn && this.ownTurn === turnId;
  }

  interrupt(): void {
    this.ownTurn = undefined;
  }

  observe(entry: UsageEntry, payload: Fields): void {
    const turn = typeof payload.turn_id === "string" && payload.turn_id ? payload.turn_id : undefined;
    if (entry.record.type === "turn_context") {
      if (this.ownTurn !== turn) this.ownTurn = undefined;
      return;
    }
    if (entry.record.type !== "event_msg") return;
    switch (payload.type) {
      case "task_started":
      case "turn_started":
        // The writer preserves this inner Unix timestamp when it re-stamps copied rows.
        this.ownTurn = typeof payload.started_at === "number" && Number.isSafeInteger(payload.started_at)
          && payload.started_at > this.forkSecond ? turn : undefined;
        break;
      case "item_started":
      case "item_completed":
        if (turn && typeof payload.thread_id === "string") this.ownTurn = payload.thread_id === entry.sessionId ? turn : undefined;
        break;
      case "task_complete":
      case "turn_complete":
      case "turn_aborted":
        this.ownTurn = undefined;
        break;
    }
  }
}

/** Keep the child's counter history separate from the reports it copied. */
export class CodexForkUsage {
  readonly turn: CodexForkTurn;
  private firstCounter = true;

  constructor(readonly plan: CodexForkCheckpoint, private readonly forkedAt?: string) {
    this.turn = new CodexForkTurn(forkedAt);
  }

  restore(state: unknown): void {
    const saved = ParserState.record(state, ["firstCounter", "ownTurn"]);
    if (typeof saved.firstCounter !== "boolean") ParserState.invalid();
    this.firstCounter = saved.firstCounter;
    this.turn.restore(saved.ownTurn);
  }

  snapshot(): object {
    return { firstCounter: this.firstCounter, ownTurn: this.turn.snapshot() };
  }

  historyId(sessionId: string): string {
    const proof = this.plan.inheritedThrough ? "verified" : "unverified";
    return `${proof}:${ParserState.digest(["codex-fork", sessionId, this.plan.parentSessionId, this.forkedAt])}`;
  }

  inherited(lineNumber: number): boolean {
    return lineNumber <= (this.plan.inheritedThrough?.lineNumber ?? 0);
  }

  interrupt(): void {
    this.turn.interrupt();
    this.firstCounter = false;
  }

  /** The first reliable child counter may start at zero even when its copy ends above zero. */
  startsFresh(report: Report, pending: ReadonlyMap<string, unknown>, known: boolean): boolean {
    const first = this.firstCounter;
    this.firstCounter = false;
    if (!first || !report.end) return false;
    if (CodexTokenCounts.sameTotals(report.end, zero)) return pending.size === 0;
    if (!report.last || !report.independent || !CodexTokenCounts.sameTotals(report.end, report.last)) return false;
    return pending.size === 0 ? !known : pending.size === 1 && pending.has(report.last.id);
  }
}
