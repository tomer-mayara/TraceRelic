import type { ScheduledScanOutcome, ScheduledScanReport } from "../../src/watch/scan-activity.ts";
import type { PendingScan } from "../../src/scan/scan-pending.ts";
import { ScheduledScanner } from "#src/watch/scheduled-scanner";
import { ManualScanClock } from "./manual-scan-clock.ts";

export class ScheduledScannerFixture {
  readonly clock = new ManualScanClock(0);
  readonly controller = new AbortController();
  readonly starts: number[] = [];
  readonly reports: ScheduledScanReport[] = [];
  readonly pending: PendingScan[] = [];
  readonly pendingDiagnostics: PendingScan[] = [];
  readonly failures: unknown[] = [];
  passes = 0;
  work: () => Promise<unknown> = async () => {};
  readonly activity = {
    beginPass: () => { this.passes++; },
    finishPass: (outcome: ScheduledScanOutcome): ScheduledScanReport => ({
      ...outcome, newSessions: 0, oldestPendingAgeMs: null,
    }),
    pending: (report: PendingScan) => { this.pending.push(report); },
  };
  readonly scanner = new ScheduledScanner(async () => {
    this.starts.push(this.clock.now());
    await this.work();
  }, this.activity, this.clock);

  run(intervalMs = 100) {
    return this.scanner.run({
      intervalMs, signal: this.controller.signal, onReport: report => this.reports.push(report),
      onPending: report => this.pendingDiagnostics.push(report), onFailure: error => this.failures.push(error),
    });
  }
}
