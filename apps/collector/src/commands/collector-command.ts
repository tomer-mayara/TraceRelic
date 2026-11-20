import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { recordedPathDialect } from "@tracerelic/shared";
import { GlobalConfigLoader } from "../config/global-config-loader.ts";
import { LocalLLMHistoryClaude, LocalLLMHistoryCodex, type LocalHistoryEntry, type ScanSelection } from "../history/index.ts";
import { isHistoryTimestamp } from "../recorded-timestamp.ts";
import { LocalCollector, type RejectedBatch } from "../scan/local-collector.ts";
import { ScanActivity, type ScheduledScanReport } from "../scan/scan-activity.ts";
import type { PendingScan } from "../scan/scan-pending.ts";
import { checkedScanIntervalMs, ScheduledScanner, type ScanClock } from "../scan/scheduled-scanner.ts";
import type { CollectorStorage, MissingSource, SessionView } from "../storage/collector-storage.ts";

const usage = "Usage: collector history --config <file> --from <instant> --to <instant>\n"
  + "       collector scan --once --config <file> [--session <id>] [--project <directory>]\n"
  + "       collector watch --config <file> [--interval-ms <milliseconds>] [--session <id>] [--project <directory>]";

type OneTimeResult = readonly SessionView[] | readonly LocalHistoryEntry[];

export interface WatchRuntime {
  signal?: AbortSignal;
  clock?: ScanClock;
  onReport: (report: ScheduledScanReport) => void;
  onPending?: (report: PendingScan) => void;
  onFailure?: (error: unknown) => void;
}

function instant(option: "--from" | "--to", value: string | undefined): string {
  if (!isHistoryTimestamp(value)) {
    throw new Error(`Expected an ISO date and time with a timezone for ${option}`);
  }
  return value;
}

function projectPath(path: string): string {
  if (recordedPathDialect(path)) return path;
  if (/^(?:[a-z]:|\\)/i.test(path)) throw new Error("Expected an absolute Windows project directory");
  return resolve(path);
}

function watchInterval(value: string | undefined): number {
  if (value === undefined) return 60_000;
  return checkedScanIntervalMs(/^\d+$/.test(value) ? Number(value) : NaN);
}

async function untilShutdown(signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
  if (signal) return run(signal);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await run(controller.signal);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

export class CollectorCommand {
  constructor(
    private readonly destination: CollectorStorage | (() => Promise<CollectorStorage>),
    private readonly onRejected?: (batch: RejectedBatch) => void,
    private readonly onMissing?: (source: MissingSource) => void,
  ) {}

  run(args: string[]): Promise<OneTimeResult>;
  run(args: string[], runtime: WatchRuntime): Promise<OneTimeResult | void>;
  async run(args: string[], runtime?: WatchRuntime): Promise<OneTimeResult | void> {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true,
      options: {
        config: { type: "string" }, from: { type: "string" }, to: { type: "string" }, once: { type: "boolean" },
        session: { type: "string", multiple: true }, project: { type: "string", multiple: true }, "interval-ms": { type: "string" },
      },
    });
    if (positionals.length !== 1 || !values.config) throw new Error(usage);
    if (positionals[0] === "history" && !values.once && !values.project && !values.session && values["interval-ms"] === undefined) {
      const from = instant("--from", values.from);
      const to = instant("--to", values.to);
      const config = await GlobalConfigLoader.load(values.config);
      const readers = [new LocalLLMHistoryCodex(config), new LocalLLMHistoryClaude(config)];
      const entries = await Promise.all(readers.map(reader => reader.readLocalHistoryInstants(from, to)));
      return entries.flat();
    }
    const once = positionals[0] === "scan" && values.once && values["interval-ms"] === undefined;
    const watch = positionals[0] === "watch" && !values.once ? runtime : undefined;
    if ((!once && !watch) || values.from !== undefined || values.to !== undefined) throw new Error(usage);
    if ([...(values.session ?? []), ...(values.project ?? [])].some(value => !value.trim() || value.includes("\0"))) {
      throw new Error("Expected a nonblank session ID or project directory");
    }
    const selection = { sessionIds: values.session, projectPaths: values.project?.map(projectPath) };
    const configFile = values.config;
    if (watch) {
      const intervalMs = watchInterval(values["interval-ms"]);
      return untilShutdown(watch.signal, async signal => {
        const activity = new ScanActivity(await this.storage(), watch.clock?.now.bind(watch.clock));
        const scan = await this.scanHandler(configFile, selection, activity);
        const scheduler = new ScheduledScanner(scan, activity, watch.clock);
        await scheduler.run({ intervalMs, signal, onReport: watch.onReport, onPending: watch.onPending, onFailure: watch.onFailure });
      });
    }
    const scan = await this.scanHandler(configFile, selection);
    return scan();
  }

  private storage(): CollectorStorage | Promise<CollectorStorage> {
    return typeof this.destination === "function" ? this.destination() : this.destination;
  }

  private async scanHandler(configFile: string, selection: ScanSelection, activity?: ScanActivity) {
    const config = await GlobalConfigLoader.load(configFile);
    const collector = new LocalCollector(config, activity ?? await this.storage(), this.onRejected, this.onMissing, activity);
    return activity ? () => collector.scanForChanges(selection) : () => collector.scanOnce(selection);
  }
}
