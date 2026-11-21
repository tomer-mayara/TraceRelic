import { LocalFileLogger } from "@tracerelic/shared/logging";

const [filePath, first, missing, limit] = process.argv.slice(2);
const logger = new LocalFileLogger({ filePath });
logger.warn(first);

const previousLimit = Error.stackTraceLimit;
try {
  Error.stackTraceLimit = Number(limit);
  logger.warn(missing);
} finally {
  Error.stackTraceLimit = previousLimit;
}

try {
  await logger.close();
} catch (error) {
  if (!(error instanceof Error)) throw error;
  process.stdout.write(error.message);
}
