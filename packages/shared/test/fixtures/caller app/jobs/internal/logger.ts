import type { Logger } from "@tracerelic/shared/logging";

export interface CallTimes {
  start: number;
  end: number;
}

export function reportWarning(logger: Logger, message: string): CallTimes {
  const start = Date.now();
  logger.warn(message);
  return { start, end: Date.now() };
}
