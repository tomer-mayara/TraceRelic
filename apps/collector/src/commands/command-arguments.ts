import { resolve } from "node:path";
import { RecordedInstant, recordedPathDialect } from "@tracerelic/shared";
import { ScheduledScanner } from "../watch/scheduled-scanner.ts";

/** Reads and checks the arguments of a collector command. */
export class CommandArguments {
  static instant(option: "--from" | "--to", value: string | undefined): string {
    if (!RecordedInstant.isTimestamp(value)) {
      throw new Error(`Expected an ISO date and time with a timezone for ${option}`);
    }
    return value;
  }

  static projectPath(path: string): string {
    if (recordedPathDialect(path)) return path;
    if (/^(?:[a-z]:|\\)/i.test(path)) throw new Error("Expected an absolute Windows project directory");
    return resolve(path);
  }

  static watchInterval(value: string | undefined): number {
    if (value === undefined) return 60_000;
    return ScheduledScanner.checkedIntervalMs(/^\d+$/.test(value) ? Number(value) : NaN);
  }
}
