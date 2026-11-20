import { CollectorCommand, type WatchRuntime } from "./commands/collector-command.ts";
import { ScanPendingError, type PendingScan } from "./scan/scan-pending.ts";
import { ScanRejectedError, type RejectedBatch } from "./scan/scan-rejected.ts";
import type { CollectorStorage, MissingSource } from "./storage/collector-storage.ts";
import { InMemoryCollectorStorage } from "./storage/in-memory-collector-storage.ts";

type CollectorCliOptions = Partial<Pick<WatchRuntime, "signal" | "clock" | "onReport">>;

async function configuredStorage(): Promise<CollectorStorage> {
  const { TRACERELIC_COLLECTOR_API_URL: apiUrl, TRACERELIC_COLLECTOR_TOKEN: token } = process.env;
  if (apiUrl === undefined && token === undefined) return new InMemoryCollectorStorage();
  if (apiUrl === undefined || token === undefined) {
    throw new Error("Set both TRACERELIC_COLLECTOR_API_URL and TRACERELIC_COLLECTOR_TOKEN for remote scans");
  }
  const { HttpCollectorStorage } = await import("./storage/http-collector-storage.ts");
  return new HttpCollectorStorage(apiUrl, token);
}

export async function runCollectorCli(args: string[], storage?: CollectorStorage, options: CollectorCliOptions = {}): Promise<number> {
  try {
    const report = (event: RejectedBatch | MissingSource | PendingScan) => console.error(JSON.stringify(event));
    const command = new CollectorCommand(storage ?? configuredStorage, report, report);
    const result = await command.run(args, {
      ...options, onReport: options.onReport ?? (pass => console.log(JSON.stringify(pass))),
      onPending: report, onFailure: () => console.error(JSON.stringify({ status: "failed", reason: "scan-failed" })),
    });
    if (result !== undefined) console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    if (error instanceof ScanRejectedError) {
      console.log(JSON.stringify(error.sessions));
      return 1;
    }
    if (error instanceof ScanPendingError) {
      console.error(JSON.stringify(error.pending));
      return 75;
    }
    console.error(error instanceof Error ? error.message : "Collector command failed");
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runCollectorCli(process.argv.slice(2));
