import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { GlobalConfigLoader } from "../config/global-config-loader.ts";
import { LocalLLMHistoryClaude, LocalLLMHistoryCodex, type LocalHistoryEntry } from "../history/index.ts";
import { isRecordedTimestamp } from "../recorded-timestamp.ts";
import { LocalCollector, type RejectedBatch } from "../scan/local-collector.ts";
import type { CollectorStorage, SessionView } from "../storage/collector-storage.ts";

const usage = "Usage: collector history --config <file> --from <instant> --to <instant>\n"
  + "       collector scan --once --config <file> [--session <id>] [--project <directory>]";

function instant(option: "--from" | "--to", value: string | undefined): Date {
  if (!value || !isRecordedTimestamp(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Expected an ISO date and time with a timezone for ${option}`);
  }
  return new Date(value);
}

export class CollectorCommand {
  constructor(private readonly storage: CollectorStorage, private readonly onRejected?: (batch: RejectedBatch) => void) {}

  async run(args: string[]): Promise<readonly SessionView[] | readonly LocalHistoryEntry[]> {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true,
      options: {
        config: { type: "string" }, from: { type: "string" }, to: { type: "string" }, once: { type: "boolean" },
        session: { type: "string", multiple: true }, project: { type: "string", multiple: true },
      },
    });
    if (positionals.length !== 1 || !values.config) throw new Error(usage);
    if (positionals[0] === "history" && !values.once && !values.project && !values.session) {
      const from = instant("--from", values.from);
      const to = instant("--to", values.to);
      const config = await GlobalConfigLoader.load(values.config);
      const readers = [new LocalLLMHistoryCodex(config), new LocalLLMHistoryClaude(config)];
      const entries = await Promise.all(readers.map(reader => reader.readLocalHistory(from, to)));
      return entries.flat();
    }
    if (positionals[0] !== "scan" || !values.once || values.from !== undefined || values.to !== undefined) {
      throw new Error(usage);
    }
    if ([...(values.session ?? []), ...(values.project ?? [])].some(value => !value.trim() || value.includes("\0"))) {
      throw new Error("Expected a nonblank session ID or project directory");
    }
    const selection = { sessionIds: values.session, projectPaths: values.project?.map(path => resolve(path)) };
    const config = await GlobalConfigLoader.load(values.config);
    return new LocalCollector(config, this.storage, this.onRejected).scanOnce(selection);
  }
}
