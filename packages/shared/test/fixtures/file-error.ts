import { LocalFileLogger, type Logger } from "@tracerelic/shared/logging";

const logger: Logger = new LocalFileLogger({ filePath: process.argv[2] });
logger.error("message");
await logger.close();
