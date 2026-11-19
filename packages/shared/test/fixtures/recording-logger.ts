import { Logger, type LogRecord } from "@tracerelic/shared/logging";

export class RecordingLogger extends Logger {
  readonly records: LogRecord[] = [];

  protected write(record: LogRecord): void {
    this.records.push(record);
  }
}
