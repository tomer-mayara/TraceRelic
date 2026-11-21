import { ConsoleLogger } from "@tracerelic/shared/logging";
import { CollectorCommand, type WatchRuntime } from "./commands/collector-command.ts";
import { ScanPendingError, type PendingScan } from "./scan/scan-pending.ts";
import { ScanRejectedError } from "./scan/scan-rejected.ts";
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
  const logger = new ConsoleLogger();
  const warn = (report: MissingSource | PendingScan) => { logger.warn(JSON.stringify(report)); };
  let exitCode = 0;
  try {
    const command = new CollectorCommand(
      storage ?? configuredStorage,
      batch => { logger.error(JSON.stringify(batch)); },
      warn,
    );
    const result = await command.run(args, {
      ...options,
      onReport: options.onReport ?? (pass => console.log(JSON.stringify(pass))),
      onPending: warn,
      onFailure: () => { logger.error(JSON.stringify({ status: "failed", reason: "scan-failed" })); },
    });
    if (result !== undefined) console.log(JSON.stringify(result));
  } catch (error) {
    exitCode = 1;
    if (error instanceof ScanRejectedError) {
      console.log(JSON.stringify(error.sessions));
    } else if (error instanceof ScanPendingError) {
      warn(error.pending);
      exitCode = 75;
    } else {
      logger.error(error instanceof Error ? error.message : "Collector command failed");
    }
  } finally {
    try {
      await logger.close();
    } catch {
      if (exitCode === 0) exitCode = 1;
    }
  }
  return exitCode;
}

if (import.meta.main) process.exitCode = await runCollectorCli(process.argv.slice(2));
