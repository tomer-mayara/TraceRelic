import { CollectorCommand } from "./commands/collector-command.ts";
import { InMemoryCollectorStorage } from "./storage/in-memory-collector-storage.ts";

try {
  const command = new CollectorCommand(new InMemoryCollectorStorage());
  console.log(JSON.stringify(await command.run(process.argv.slice(2))));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Collector command failed");
  process.exitCode = 1;
}
