import { CollectorCommand } from "./commands/collector-command.ts";
import { ScanPendingError } from "./scan/scan-pending.ts";
import { ScanRejectedError } from "./scan/scan-rejected.ts";
import type { CollectorStorage } from "./storage/collector-storage.ts";
import { InMemoryCollectorStorage } from "./storage/in-memory-collector-storage.ts";

export async function runCollectorCli(args: string[], storage: CollectorStorage): Promise<number> {
  try {
    const command = new CollectorCommand(storage, rejected => console.error(JSON.stringify(rejected)));
    console.log(JSON.stringify(await command.run(args)));
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
