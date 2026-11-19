import { parseArgs } from "node:util";
import { GlobalConfigLoader } from "./config/global-config-loader.ts";
import { LocalLLMHistoryClaude, LocalLLMHistoryCodex } from "./history/index.ts";
import { isRecordedTimestamp } from "./recorded-timestamp.ts";

const usage = "Usage: collector history --config <file> --from <instant> --to <instant>";

function instant(option: "--from" | "--to", value: string | undefined): Date {
  if (!value || !isRecordedTimestamp(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Expected an ISO date and time with a timezone for ${option}`);
  }
  return new Date(value);
}

async function main(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { config: { type: "string" }, from: { type: "string" }, to: { type: "string" } },
  });
  if (positionals.length !== 1 || positionals[0] !== "history" || !values.config) throw new Error(usage);
  const from = instant("--from", values.from);
  const to = instant("--to", values.to);
  const config = await GlobalConfigLoader.load(values.config);
  const readers = [new LocalLLMHistoryCodex(config), new LocalLLMHistoryClaude(config)];
  const entries = await Promise.all(readers.map(reader => reader.readLocalHistory(from, to)));
  console.log(JSON.stringify(entries.flat()));
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Collector history failed");
  process.exitCode = 1;
}
