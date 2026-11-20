import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { fullFormats } from "ajv-formats/dist/formats.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function section(document: unknown, ...path: string[]): Record<string, unknown> {
  let current = document;
  for (const key of path) {
    assert(isObject(current) && Object.hasOwn(current, key), path.join("/"));
    current = current[key];
  }
  assert(isObject(current), path.join("/"));
  return current;
}

const location = new URL("dist/contracts/openapi.json", import.meta.resolve("@tracerelic/api/package.json"));
export const published = section(JSON.parse(readFileSync(location, "utf8")));

// Keep the OpenAPI document's local references while validating the individual body schemas.
const validator = new Ajv2020({ formats: fullFormats })
  .addVocabulary(["paths", "components"])
  .addSchema({ $id: "openapi.json", paths: published.paths, components: published.components });

export function acceptsBody(resource: string, status: number | "request", body: unknown): boolean {
  const content = status === "request" ? "requestBody" : `responses/${status}`;
  const ref = `openapi.json#/paths/~1v1~1collector~1${resource}/post/${content}/content/application~1json/schema`;
  return validator.validate(ref, body);
}
