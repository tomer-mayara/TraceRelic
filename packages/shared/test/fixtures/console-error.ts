import { ConsoleLogger, type Logger } from "@tracerelic/shared/logging";

const logger: Logger = new ConsoleLogger();
logger.error("message");
