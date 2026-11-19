import assert from "node:assert/strict";
import { test } from "node:test";
import { type GlobalConfigFile, globalConfigFileSchema } from "@tracerelic/collector/config";

test("publishes codexPath as a required string setting for configuration files", () => {
  const field = "codexPath" satisfies keyof GlobalConfigFile;
  assert.ok(globalConfigFileSchema.required.includes(field));
  assert.equal(globalConfigFileSchema.properties[field].type, "string");
});
