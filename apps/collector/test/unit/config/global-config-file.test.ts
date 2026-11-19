import assert from "node:assert/strict";
import { test } from "node:test";
import { type GlobalConfigFile, globalConfigFileSchema } from "@tracerelic/collector/config";

test("publishes codexPath as a required string setting for configuration files", () => {
  const field = "codexPath" satisfies keyof GlobalConfigFile;
  assert.ok(globalConfigFileSchema.required.includes(field));
  assert.equal(globalConfigFileSchema.properties[field].type, "string");
});

test("publishes claudePath as an optional string with the provider path rules", () => {
  const field = "claudePath" satisfies keyof GlobalConfigFile;
  assert.deepEqual(globalConfigFileSchema.required, ["codexPath"]);
  assert.equal(globalConfigFileSchema.properties[field].type, "string");
  assert.equal(globalConfigFileSchema.properties[field].pattern, globalConfigFileSchema.properties.codexPath.pattern);
});
