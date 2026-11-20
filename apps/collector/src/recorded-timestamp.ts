import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";

export const isRecordedTimestamp = new Ajv2020({ formats: fullFormats })
  .compile<string>({ type: "string", format: "date-time" });

/** Preserve all fractional digits and order a leap second after every fraction of second 59. */
export function recordedInstant(at: unknown) {
  if (typeof at !== "string" || !isRecordedTimestamp(at)) return;
  const seconds = at.slice(17, 19);
  const tail = at.slice(19);
  const zoneStart = tail.search(/[z+-]/i);
  const zone = tail.slice(zoneStart);
  const offset = zone.length === 3 ? `${zone}:00` : zone;
  const second = Date.parse(`${at.slice(0, 10)}T${at.slice(11, 17)}${seconds === "60" ? "59" : seconds}${offset}`) / 1000;
  if (!Number.isFinite(second)) return;
  const fraction = (seconds === "60" ? "1" : "0") + tail.slice(1, zoneStart).replace(/0+$/, "");
  return { second, fraction };
}
