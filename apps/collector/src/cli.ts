import { CollectorCommand, type WatchRuntime } from "./commands/collector-command.ts";
import { ScanPendingError, type PendingScan } from "./scan/scan-pending.ts";
import { ScanRejectedError, type RejectedBatch } from "./scan/scan-rejected.ts";
import type { CollectorStorage, MissingSource } from "./storage/collector-storage.ts";
import { InMemoryCollectorStorage } from "./storage/in-memory-collector-storage.ts";

type CollectorCliOptions = Partial<Pick<WatchRuntime, "signal" | "clock" | "onReport">>;

export async function runCollectorCli(args: string[], storage: CollectorStorage, options: CollectorCliOptions = {}): Promise<number> {
  try {
    const report = (event: RejectedBatch | MissingSource | PendingScan) => console.error(JSON.stringify(event));
    const command = new CollectorCommand(storage, report, report);
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

if (import.meta.main) process.exitCode = await runCollectorCli(process.argv.slice(2), new InMemoryCollectorStorage());
