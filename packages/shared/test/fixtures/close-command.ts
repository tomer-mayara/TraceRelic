import { text } from "node:stream/consumers";
import { ConsoleLogger, LocalFileLogger } from "@tracerelic/shared/logging";

const [mode, message, lateMessage] = process.argv.slice(2);
if (mode === "closed-pipe") await text(process.stdin);
const logger = mode === "directory" ? new LocalFileLogger({ filePath: message }) : new ConsoleLogger();
logger.warn(mode === "healthy" ? message : "Warning");
const first = logger.close();

if (mode === "healthy") {
  const second = logger.close();
  let lateError: string | undefined;
  try {
    logger.warn(lateMessage);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    lateError = error.message;
  }
  await Promise.all([first, second]);
  console.log(JSON.stringify({ lateError, sameClose: first === second }));
  process.stderr.write("Done\n");
} else {
  try {
    await first;
    console.log(JSON.stringify({ closed: true }));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.log(JSON.stringify({
      message: error.message,
      code: Reflect.get(error, "code"),
      causeCode: error.cause instanceof Error ? Reflect.get(error.cause, "code") : undefined,
      filePath: Reflect.get(error, "filePath"),
    }));
  }
}
