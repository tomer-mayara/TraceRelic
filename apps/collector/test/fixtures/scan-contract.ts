import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";

const schemaFile = new URL(
  "../../dist/collector-scan/scan.schema.json", import.meta.resolve("@tracerelic/collector/package.json"),
);
const schema: unknown = JSON.parse(readFileSync(schemaFile, "utf8"));
assert(schema && typeof schema === "object" && "$schema" in schema && typeof schema.$schema === "string");
export const scanContract = new Ajv2020({ formats: fullFormats }).addSchema({ ...schema, $schema: schema.$schema });
