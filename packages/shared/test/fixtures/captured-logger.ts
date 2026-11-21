import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ConsoleLogger, LocalFileLogger, type Logger, type LoggerOptions } from "@tracerelic/shared/logging";
import { replaceStderr } from "./stderr.ts";

export type LogDestination = "the console" | "the local file";

export function logEachLevel(logger: Logger): void {
  logger.debug("message");
  logger.info("message");
  logger.warn("message");
  logger.error("message");
}

export class CapturedLogger {
  private constructor(
    readonly logger: Logger,
    private readonly read: () => string | Promise<string>,
    private readonly cleanup: () => void | Promise<void>,
  ) {}

  static async open(destination: LogDestination, options?: LoggerOptions): Promise<CapturedLogger> {
    if (destination === "the local file") {
      const directory = await mkdtemp(join(tmpdir(), "tracerelic-log-"));
      const filePath = join(directory, "app.jsonl");
      return new CapturedLogger(new LocalFileLogger({ ...options, filePath }),
        () => readFile(filePath, "utf8"), () => rm(directory, { recursive: true, force: true }));
    }

    const pipe = new PassThrough();
    let text = "";
    pipe.setEncoding("utf8").on("data", (chunk: string) => { text += chunk; });
    const restoreStderr = replaceStderr(pipe);
    return new CapturedLogger(new ConsoleLogger(options), () => text, () => {
      restoreStderr();
      pipe.destroy();
    });
  }

  async text(): Promise<string> {
    await this.logger.close();
    return this.read();
  }

  async dispose(): Promise<void> {
    try {
      await this.logger.close();
    } finally {
      await this.cleanup();
    }
  }
}
