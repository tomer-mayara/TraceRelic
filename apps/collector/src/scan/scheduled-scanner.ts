import { setTimeout } from "node:timers/promises";
import type { ScanActivity, ScheduledScanReport } from "./scan-activity.ts";
import { ScanPendingError, type PendingScan } from "./scan-pending.ts";
import { ScanRejectedError } from "./scan-rejected.ts";

export interface ScanClock {
  /** UTC milliseconds since the Unix epoch, used with the pending report's retry time. */
  now(): number;
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}

const systemClock: ScanClock = {
  now: () => Date.now(),
  wait: (delayMs, signal) => setTimeout(delayMs, undefined, { signal }),
};

const maxTimerMs = 2_147_483_647;

export function checkedScanIntervalMs(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maxTimerMs) {
    throw new Error(`--interval-ms must be an integer from 1 through ${maxTimerMs}`);
  }
  return value;
}

interface ScheduleOptions {
  intervalMs: number;
  signal: AbortSignal;
  onReport: (report: ScheduledScanReport) => void;
  onPending?: (pending: PendingScan) => void;
  onFailure?: (error: unknown) => void;
}

export class ScheduledScanner {
  private running = false;

  constructor(private readonly scanOnce: () => Promise<unknown>,
    private readonly activity: Pick<ScanActivity, "beginPass" | "finishPass" | "pending">,
    private readonly clock: ScanClock = systemClock) {}

  async run(options: ScheduleOptions): Promise<void> {
    if (this.running) throw new Error("The scheduled scanner is already running");
    const { signal } = options;
    const intervalMs = checkedScanIntervalMs(options.intervalMs);
    const start = this.clock.now();
    this.running = true;
    try {
      while (!signal.aborted) {
        const report = await this.scan(options);
        options.onReport(report);
        if (signal.aborted) break;
        const now = this.clock.now();
        const nextTick = start + (Math.floor((now - start) / intervalMs) + 1) * intervalMs;
        const retryAt = report.status === "pending" ? Date.parse(report.retryAt) : now;
        await this.waitUntil(retryAt > now ? retryAt : nextTick, signal);
      }
    } finally {
      this.running = false;
    }
  }

  private async scan(options: ScheduleOptions): Promise<ScheduledScanReport> {
    this.activity.beginPass();
    try {
      await this.scanOnce();
    } catch (error) {
      if (error instanceof ScanPendingError) {
        this.activity.pending(error.pending);
        options.onPending?.(error.pending);
        return this.activity.finishPass({ status: "pending", retryAt: error.pending.retryAt });
      }
      if (error instanceof ScanRejectedError) return this.activity.finishPass({ status: "rejected" });
      options.onFailure?.(error);
      return this.activity.finishPass({ status: "failed" });
    }
    return this.activity.finishPass({ status: "complete" });
  }

  private async waitUntil(deadline: number, signal: AbortSignal): Promise<void> {
    try {
      let remaining = deadline - this.clock.now();
      while (remaining > 0 && !signal.aborted) {
        await this.clock.wait(Math.min(remaining, maxTimerMs), signal);
        remaining = deadline - this.clock.now();
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
