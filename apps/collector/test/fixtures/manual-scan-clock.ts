import type { ScanClock } from "../../src/scan/scheduled-scanner.ts";

export class ManualScanClock implements ScanClock {
  private timer?: { at: number; wake: () => void };
  private readonly observers: Array<() => void> = [];

  constructor(private time = Date.now()) {}

  now(): number { return this.time; }

  wait(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    if (this.timer) throw new Error("A scan timer is already waiting");
    return new Promise(resolve => {
      const wake = () => {
        signal.removeEventListener("abort", wake);
        this.timer = undefined;
        resolve();
      };
      this.timer = { at: this.time + delayMs, wake };
      signal.addEventListener("abort", wake, { once: true });
      for (const observe of this.observers.splice(0)) observe();
    });
  }

  /** Wait until the scan is complete and the scheduler has armed its next timer. */
  whenWaiting(): Promise<void> {
    if (this.timer) return Promise.resolve();
    return new Promise(resolve => this.observers.push(resolve));
  }

  advance(ms: number): void {
    this.time += ms;
    if (this.timer && this.timer.at <= this.time) this.timer.wake();
  }
}
