import { setTimeout as delay } from "node:timers/promises";
import { runCollectorCli } from "#src/cli";
import type { ScheduledScanReport } from "../../src/watch/scan-activity.ts";
import type { CollectorStorage } from "../../src/storage/collector-storage.ts";
import { ManualScanClock } from "./manual-scan-clock.ts";

export class ScheduledScanFixture {
  readonly reports: ScheduledScanReport[] = [];
  readonly clock: ManualScanClock;
  readonly intervalMs: number;
  private readonly shutdown = new AbortController();
  private readonly run: Promise<number>;

  constructor(storage: CollectorStorage, options: string[], timing: { intervalMs?: number; startMs?: number } = {}) {
    this.clock = new ManualScanClock(timing.startMs);
    this.intervalMs = timing.intervalMs ?? 10_000;
    this.run = runCollectorCli(["watch", "--interval-ms", String(this.intervalMs), ...options], storage, {
      signal: this.shutdown.signal, clock: this.clock, onReport: report => this.reports.push(report),
    });
  }

  async waitForPass(): Promise<void> {
    await this.bounded(Promise.race([
      this.clock.whenWaiting(),
      this.run.then(code => { throw new Error(`watch exited with code ${code} before the next interval`); }),
    ]), "finish the scan");
  }

  async advance(milliseconds = this.intervalMs): Promise<void> {
    this.clock.advance(milliseconds);
    await this.waitForPass();
  }

  stop(): Promise<number> {
    this.shutdown.abort();
    return this.bounded(this.run, "shut down");
  }

  private async bounded<T>(operation: Promise<T>, expected: string): Promise<T> {
    const timer = new AbortController();
    try {
      const timeout = delay(4_000, undefined, { signal: timer.signal })
        .then(() => { throw new Error(`watch did not ${expected}`); });
      return await Promise.race([operation, timeout]);
    } finally {
      timer.abort();
    }
  }
}
