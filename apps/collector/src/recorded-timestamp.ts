import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";

export const isRecordedTimestamp = new Ajv2020({ formats: fullFormats })
  .compile<string>({ type: "string", format: "date-time" });
